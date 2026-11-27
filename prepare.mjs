import {createHash} from 'node:crypto';
import {cp, mkdir, readFile, writeFile} from 'node:fs/promises';

const file = path => new URL(path, import.meta.url);
const modelUrl = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const modelHash = '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff';
const modelCache = file('.cache/face_landmarker.task');
const matches = bytes => createHash('sha256').update(bytes).digest('hex') === modelHash;
let model = await readFile(modelCache).catch(error => {
  if (error.code !== 'ENOENT') throw error;
  return null;
});
if (!model || !matches(model)) {
  const response = await fetch(modelUrl, {signal: AbortSignal.timeout(60_000)});
  if (!response.ok) throw new Error(`MediaPipe : téléchargement impossible (${response.status}).`);
  model = Buffer.from(await response.arrayBuffer());
  if (!matches(model)) throw new Error('MediaPipe : empreinte SHA-256 inattendue.');
  await mkdir(file('.cache/'), {recursive: true});
  await writeFile(modelCache, model);
}
await mkdir(file('dist'), {recursive: true});
await cp(file('static/'), file('dist/'), {recursive: true});
await cp(file('frontend/'), file('dist/'), {recursive: true});
await mkdir(file('dist/vendor/'), {recursive: true});
const vendor = 'node_modules/@mediapipe/tasks-vision/';
for (const name of ['vision_bundle.mjs', 'wasm']) {
  await cp(file(vendor + name), file('dist/vendor/' + name), {recursive: true});
}
await writeFile(file('dist/face_landmarker.task'), model);
const index = file('dist/index.html');
const html = await readFile(index, 'utf8');
await writeFile(index, html.replace('  <script src="/app.js" defer>', '  <script src="/desktop.js" defer></script>\n  <script src="/app.js" defer>'));
