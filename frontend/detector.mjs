import {FaceLandmarker, FilesetResolver} from '/vendor/vision_bundle.mjs';

let detector;
export async function landmarks(image) {
  detector ??= FilesetResolver.forVisionTasks('/vendor/wasm').then(files =>
    FaceLandmarker.createFromOptions(files, {
      baseOptions: {modelAssetPath: '/face_landmarker.task', delegate: 'CPU'},
      canvas: document.createElement('canvas'),
      runningMode: 'IMAGE', numFaces: 2,
    })).catch(error => { detector = undefined; throw error; });
  const {faceLandmarks: faces} = (await detector).detect(image);
  if (!faces.length) throw new Error('Aucun visage détecté.');
  if (faces.length !== 1) throw new Error('Plusieurs visages détectés. Importe un portrait individuel.');
  return faces[0].map(({x, y}) => [x, y]);
}
