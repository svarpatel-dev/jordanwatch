// The camera scan: opens the phone's rear camera and runs camera model v1
// (trained in Colab, Oct 10) on what it sees.
// Knows nothing about the page layout or the verdict rules.
// Uses TensorFlow.js, loaded in index.html as the global "tf".

const MODEL_URL = "model/colab-v1/model.json";

// The model's 4 outputs, in this order (same as the training folders)
export const CLASSES = ["bloom", "vegetation", "clear_water", "not_water"];

// Below this confidence the scan says "Uncertain" (decided Oct 10)
export const UNCERTAIN_BELOW = 0.7;

// The model looks at 224 x 224 pixel squares, like the training photos
const SIZE = 224;

// The model is loaded once and reused (like saving it in a variable
// in Python instead of reloading it for every frame)
let modelPromise = null;

export function loadModel() {
  if (!modelPromise) {
    modelPromise = tf.loadLayersModel(MODEL_URL);
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

// Classify what the camera shows right now.
// Returns e.g. { label: "bloom", topClass: "bloom", confidence: 0.91 }
// label is "uncertain" when the model's best guess is below 70%.
export function classifyFrame(model, video) {
  // tf.tidy frees the memory of every tensor made inside it
  // (otherwise the phone would run out of memory after a few seconds)
  const probabilities = tf.tidy(() => {
    const frame = tf.browser.fromPixels(video);       // height x width x 3, values 0-255
    const square = centerSquare(frame);
    const input = tf.image.resizeBilinear(square, [SIZE, SIZE])
      .toFloat()
      .div(127.5).sub(1)                              // same scaling as training: -1 to 1
      .expandDims(0);                                 // a "batch" of one image
    return model.predict(input).dataSync();
  });

  const scores = Array.from(probabilities);
  const best = scores.indexOf(Math.max(...scores));
  const confidence = scores[best];

  return {
    label: confidence >= UNCERTAIN_BELOW ? CLASSES[best] : "uncertain",
    topClass: CLASSES[best],
    confidence
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
