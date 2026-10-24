// The camera scan: opens the phone's rear camera and runs camera model v1
// (trained in Colab, Oct 10) on a picture of the water.
// Tap to scan (decided Oct 24): the live view only shows the camera; a tap
// looks at several frames and averages them into one steady result. A photo
// from the phone's library or camera gets the same single result.
// Knows nothing about the page layout or the verdict rules.
// Uses TensorFlow.js, loaded in index.html as the global "tf".

const MODEL_URL = "model/colab-v1/model.json";

// The model's 4 outputs, in this order (same as the training folders)
export const CLASSES = ["bloom", "vegetation", "clear_water", "not_water"];

// Below this confidence the scan says "Uncertain" (decided Oct 10)
export const UNCERTAIN_BELOW = 0.7;

// One tap looks at this many frames, this far apart (about 1.5 seconds),
// and averages them (decided Oct 24: one frame's answer jumped around too much)
export const SCAN_FRAMES = 8;
const FRAME_GAP_MS = 200;

// The model looks at 224 x 224 pixel squares, like the training photos
const SIZE = 224;

// A photo is shrunk to this many pixels on its shorter side before the model
// sees it (a 12-megapixel photo would use a lot of the phone's memory; the
// model only needs 224 anyway)
const PHOTO_SIDE = 640;

// The model is loaded once and reused (like saving it in a variable
// in Python instead of reloading it for every frame)
let modelPromise = null;

export function loadModel() {
  if (!modelPromise) {
    modelPromise = tf.loadLayersModel(MODEL_URL);
    // If loading fails (e.g. no connection), try again next time
    modelPromise.catch(() => { modelPromise = null; });
  }
  return modelPromise;
}

// Ask for the rear camera ("environment") and show it in the <video>.
// Browsers only allow the camera on https:// pages (and localhost).
export async function startCamera(video) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("this browser can't open the camera here (it needs a secure https:// page)");
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment" },
    audio: false
  });
  video.srcObject = stream;
  await video.play();
}

// Turn the camera off (the phone's camera light goes out)
export function stopCamera(video) {
  const stream = video.srcObject;
  if (stream) {
    stream.getTracks().forEach(track => track.stop());
  }
  video.srcObject = null;
}

// Copy what the camera shows right now onto a canvas, so the picture
// "freezes" while the scan looks at it (the video keeps running underneath)
export function freezeFrame(video, canvas) {
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d").drawImage(video, 0, 0);
}

// Draw a photo file onto a canvas, shrunk so its shorter side is at most
// PHOTO_SIDE pixels. Phones' sideways photos come out upright (browsers
// follow the photo's rotation tag when drawing it).
export async function drawPhoto(file, canvas) {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();          // waits until the picture is loaded
    const scale = Math.min(1, PHOTO_SIDE / Math.min(image.naturalWidth, image.naturalHeight));
    canvas.width = Math.round(image.naturalWidth * scale);
    canvas.height = Math.round(image.naturalHeight * scale);
    canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
  } finally {
    URL.revokeObjectURL(url);      // frees the file's copy in memory
  }
}

// The model's 4 probabilities for one picture (a <video>, <canvas> or <img>),
// e.g. [0.81, 0.05, 0.10, 0.04] in the order of CLASSES
export function classScores(model, source) {
  // tf.tidy frees the memory of every tensor made inside it
  // (otherwise the phone would run out of memory after a few scans)
  const probabilities = tf.tidy(() => {
    const frame = tf.browser.fromPixels(source);      // height x width x 3, values 0-255
    const square = centerSquare(frame);
    const input = tf.image.resizeBilinear(square, [SIZE, SIZE])
      .toFloat()
      .div(127.5).sub(1)                              // same scaling as training: -1 to 1
      .expandDims(0);                                 // a "batch" of one image
    return model.predict(input).dataSync();
  });
  return Array.from(probabilities);
}

// Look at the live camera SCAN_FRAMES times and average the probabilities
// (like numpy.mean(scores, axis=0) in Python). onFrame(done, total) is called
// after each frame, for the progress bar.
export async function scanLive(model, video, onFrame) {
  const all = [];
  for (let i = 0; i < SCAN_FRAMES; i++) {
    if (i > 0) await wait(FRAME_GAP_MS);
    if (!video.srcObject) throw new Error("the camera was turned off");
    all.push(classScores(model, video));
    onFrame?.(i + 1, SCAN_FRAMES);
  }
  return resultFrom(averageScores(all), SCAN_FRAMES);
}

// One photo: a single look (a still picture gives the same answer every time)
export function scanPicture(model, picture) {
  return resultFrom(classScores(model, picture), 1);
}

// The average of each class's probability over several frames
function averageScores(all) {
  return CLASSES.map((_, k) => all.reduce((sum, scores) => sum + scores[k], 0) / all.length);
}

// Turn probabilities into a result, e.g.
// { label: "bloom", topClass: "bloom", confidence: 0.91, frames: 8 }
// label is "uncertain" when the model's best guess is below 70%.
function resultFrom(scores, frames) {
  const best = scores.indexOf(Math.max(...scores));
  const confidence = scores[best];
  return {
    label: confidence >= UNCERTAIN_BELOW ? CLASSES[best] : "uncertain",
    topClass: CLASSES[best],
    confidence,
    frames
  };
}

// The middle square of the frame, the same crop the training photos got
// (build_dataset.py), so the model sees images shaped like the ones it learned from
function centerSquare(frame) {
  const [height, width] = frame.shape;
  const side = Math.min(height, width);
  const top = Math.floor((height - side) / 2);
  const left = Math.floor((width - side) / 2);
  return frame.slice([top, left, 0], [side, side, 3]);
}

// Pause for ms milliseconds (like time.sleep, but await-able so the page
// doesn't freeze)
function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
