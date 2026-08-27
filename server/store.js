// JSON 파일 스토어 — 라이브러리·런다운 규모에 이 정도면 충분하다.
// 쓰기는 임시 파일에 쓴 뒤 rename 하여, 중간에 죽어도 파일이 깨지지 않게 한다.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const DEFAULT = {
  library: [],        // Item[]
  blocks: [],         // Block[]  — 편성 규칙 (§3.5.1)
  autofill: { enabled: false, poolIds: [], order: 'random' },
  playlog: {},        // itemId → 마지막 방영 시각 ('미방영 우선' 순서용)
  rundown: { id: 'r1', items: [] },
  updatedAt: 0,
};

export class Store {
  constructor(file) {
    this.file = file;
    mkdirSync(path.dirname(file), { recursive: true });
    this.data = existsSync(file) ? this.#read() : structuredClone(DEFAULT);
  }

  #read() {
    try {
      return { ...structuredClone(DEFAULT), ...JSON.parse(readFileSync(this.file, 'utf8')) };
    } catch (e) {
      console.error('[store] 파일을 읽지 못해 기본값으로 시작합니다:', e.message);
      return structuredClone(DEFAULT);
    }
  }

  save() {
    this.data.updatedAt = Date.now();
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
  }

  get(key) { return this.data[key]; }
  set(key, value) { this.data[key] = value; this.save(); return value; }
}
