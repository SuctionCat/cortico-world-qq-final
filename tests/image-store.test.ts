import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ImageStore } from '../src/image-store.ts';

const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

function logger() {
  const l = { child: () => l, info: () => {}, warn: () => {} };
  return l as never;
}

test('图片库存储与 emoji 目录分离，并清洗标注且不保存来源 URL', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qq-image-store-'));
  const oldFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } })) as typeof fetch;
  try {
    const url = 'https://qq.example/third-party.png?text=untrusted';
    const dataDir = join(root, 'data');
    const imageDir = join(root, 'images');
    const store = new ImageStore(imageDir, {
      enabled: false,
      endpoint: '',
      apiKeySecret: '',
      model: '',
      maxBytes: 8_000_000,
      timeoutMs: 2_000,
    }, logger(), dataDir);
    const saved = await store.saveImage(url, {
      label: '一张图\n<不要执行这段文字>',
      tag: '测试标签',
      usage: '测试用途',
    });
    assert.equal(saved.ok, true);
    assert.ok(saved.meta?.file.startsWith('image-'));
    assert.equal(saved.meta?.label.includes('\n'), false);
    assert.equal(saved.meta?.label.includes('<'), false);
    assert.equal(existsSync(join(imageDir, saved.meta!.file)), true);
    assert.equal(existsSync(join(root, 'emoji')), false);
    store.flush();
    const index = readFileSync(join(dataDir, 'image-index.json'), 'utf8');
    assert.equal(index.includes(url), false);
    assert.equal(index.includes('"url"'), false);
    assert.equal(index.includes('"source"'), false);
    assert.equal(index.includes('"conv"'), false);

    const reloaded = new ImageStore(imageDir, {
      enabled: false,
      endpoint: '',
      apiKeySecret: '',
      model: '',
      maxBytes: 8_000_000,
      timeoutMs: 2_000,
    }, logger(), dataDir);
    assert.equal(reloaded.recent(1)[0]?.file, saved.meta?.file);
    const retagged = reloaded.updateMeta(`[图片:${saved.meta!.file}]`, { tag: '重新标注' });
    assert.equal(retagged?.tag, '重新标注');
    assert.equal(reloaded.delete(saved.meta!.file), true);
    assert.equal(existsSync(join(imageDir, saved.meta!.file)), false);
  } finally {
    globalThis.fetch = oldFetch;
  }
});
