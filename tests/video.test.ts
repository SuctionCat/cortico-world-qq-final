import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { VideoStore } from '../src/video.ts';

function logger() {
  const l = { child: () => l, info: () => {}, warn: () => {} };
  return l as never;
}

test('视频只接受 http(s)，按哈希文件名保存到独立目录', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qq-video-store-'));
  const oldFetch = globalThis.fetch;
  const bytes = Uint8Array.from([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);
  globalThis.fetch = (async () => new Response(bytes, { status: 200 })) as typeof fetch;
  try {
    const store = new VideoStore(join(root, 'videos'), ['definitely-missing-ffmpeg'], logger(), 1024, 2000);
    assert.equal(await store.saveAndExtract('file:///secret.mp4', 1, 12), null);
    const saved = await store.saveAndExtract('https://qq.example/video.mp4?untrusted=1', 1, 12);
    assert.ok(saved);
    assert.match(saved.file, /^video-[a-f0-9]{16}\.mp4$/);
    assert.equal(existsSync(join(root, 'videos', saved.file)), true);
    assert.deepEqual(readFileSync(join(root, 'videos', saved.file)), Buffer.from(bytes));
    assert.equal(saved.frameBytes, null);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('视频时间轴在 ffmpeg 不可用时保留文件并静默返回空片段', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qq-video-timeline-'));
  const oldFetch = globalThis.fetch;
  const bytes = Uint8Array.from([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);
  globalThis.fetch = (async () => new Response(bytes, { status: 200 })) as typeof fetch;
  try {
    const store = new VideoStore(join(root, 'videos'), ['definitely-missing-ffmpeg'], logger(), 1024, 2000);
    const timeline = await store.saveAndExtractTimeline('https://qq.example/video.mp4', {
      intervalSec: 1,
      segmentSec: 8,
      maxFrames: 8,
      maxSegments: 3,
      audio: true,
    });
    assert.ok(timeline);
    assert.equal(timeline.durationSec, null);
    assert.deepEqual(timeline.segments, []);
    assert.equal(existsSync(join(root, 'videos', timeline.file)), true);
  } finally {
    globalThis.fetch = oldFetch;
  }
});
