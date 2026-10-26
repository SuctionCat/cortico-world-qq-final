import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { spawn } from 'node:child_process';
import type { Logger } from 'cortico/core/types.ts';

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const FRAME_SIZE = 320;
const VIDEO_EXTENSIONS = ['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi', '.flv', '.ts', '.3gp'];

export interface VideoProcessResult {
  file: string;
  bytes: number;
  frameBytes: Uint8Array | null;
}

/** 下载视频并生成受限数量的拼接帧图；索引只使用内容哈希文件名，不保存来源地址。 */
export class VideoStore {
  private readonly dir: string;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  private readonly ffmpegCandidates: string[];
  private readonly log: Logger;

  constructor(
    dir: string,
    ffmpegCandidates: string[],
    log: Logger,
    maxBytes = DEFAULT_MAX_BYTES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {
    this.dir = dir;
    this.ffmpegCandidates = ffmpegCandidates.filter(Boolean);
    this.log = log.child('video');
    this.maxBytes = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.min(maxBytes, DEFAULT_MAX_BYTES) : DEFAULT_MAX_BYTES;
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    } catch {
      this.log.warn('无法创建视频目录', { dir: this.dir });
    }
  }

  async saveAndExtract(url: string, intervalSec: number, maxFrames: number): Promise<VideoProcessResult | null> {
    const bytes = await this.fetchBytes(url);
    if (!bytes) return null;
    const hash = createHash('sha256').update(bytes).digest('hex');
    const file = `video-${hash.slice(0, 16)}${this.extOf(url, bytes)}`;
    const filePath = join(this.dir, file);
    try {
      writeFileSync(filePath, bytes, { flag: 'wx' });
    } catch {
      if (!existsSync(filePath)) return null;
    }
    const frameBytes = await this.extractFrames(filePath, intervalSec, maxFrames);
    if (!frameBytes) this.log.warn('视频抽帧失败，保留已下载文件', { file });
    return { file, bytes: bytes.byteLength, frameBytes };
  }

  private async fetchBytes(url: string): Promise<Uint8Array | null> {
    if (!/^https?:\/\//i.test(url)) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) return null;
      const length = Number(res.headers.get('content-length') ?? '');
      if (Number.isFinite(length) && length > this.maxBytes) return null;
      if (!res.body) {
        const body = new Uint8Array(await res.arrayBuffer());
        return body.byteLength <= this.maxBytes ? body : null;
      }
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          total += part.value.byteLength;
          if (total > this.maxBytes) {
            await reader.cancel();
            return null;
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
      const out = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return out;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private extractFrames(filePath: string, intervalSec: number, maxFrames: number): Promise<Uint8Array | null> {
    const interval = Math.max(0.1, Math.min(3600, Number.isFinite(intervalSec) ? intervalSec : 1));
    const frames = Math.max(1, Math.min(36, Math.floor(Number.isFinite(maxFrames) ? maxFrames : 12)));
    const columns = Math.min(4, frames);
    const rows = Math.ceil(frames / columns);
    const fps = (1 / interval).toFixed(6).replace(/0+$/, '').replace(/\.$/, '') || '1';
    const filter = [
      `fps=${fps}`,
      `scale=${FRAME_SIZE}:${FRAME_SIZE}:force_original_aspect_ratio=decrease`,
      `pad=${FRAME_SIZE}:${FRAME_SIZE}:(ow-iw)/2:(oh-ih)/2`,
      `tile=${columns}x${rows}:padding=4:margin=4`,
    ].join(',');
    const args = [
      '-hide_banner', '-loglevel', 'error', '-i', filePath,
      '-vf', filter, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1',
    ];
    const candidates = this.ffmpegCandidates.length ? this.ffmpegCandidates : ['ffmpeg'];
    return this.tryFfmpeg(candidates, args);
  }

  private tryFfmpeg(candidates: string[], args: string[], index = 0): Promise<Uint8Array | null> {
    if (index >= candidates.length) return Promise.resolve(null);
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (result: Uint8Array | null, retry: boolean) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (retry) void this.tryFfmpeg(candidates, args, index + 1).then(resolve);
        else resolve(result);
      };
      let proc: ReturnType<typeof spawn>;
      try {
        proc = spawn(candidates[index], args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      } catch {
        finish(null, true);
        return;
      }
      const chunks: Buffer[] = [];
      proc.stdout?.on('data', (part) => chunks.push(part as Buffer));
      proc.once('error', () => finish(null, true));
      proc.once('close', (code) => finish(code === 0 && chunks.length ? Buffer.concat(chunks) : null, code !== 0));
      timer = setTimeout(() => {
        try { proc.kill(); } catch { /* ignore */ }
        finish(null, false);
      }, Math.max(this.timeoutMs, 10_000));
    });
  }

  private extOf(url: string, bytes: Uint8Array): string {
    const fromUrl = extname(url.split('?')[0]).toLowerCase();
    if (VIDEO_EXTENSIONS.includes(fromUrl)) return fromUrl;
    const head = Buffer.from(bytes.subarray(0, 16));
    if (head.toString('ascii', 4, 8) === 'ftyp') return '.mp4';
    if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return '.webm';
    if (head.toString('ascii', 0, 4) === 'RIFF') return '.avi';
    return '.video';
  }
}
