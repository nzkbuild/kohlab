/** Pure coordinate maths for the shared browser: CSS pixels in, device pixels out. */

export interface Size {
  width: number;
  height: number;
}

/** A box in CSS pixels. A DOMRect fits this shape. */
export interface Box extends Size {
  left: number;
  top: number;
}

export interface Point {
  x: number;
  y: number;
}

/**
 * Where an image of `image` size sits inside `box` when it fits without cropping
 * (object-fit: contain). Returned relative to the box's own top left.
 */
export function containRect(box: Size, image: Size): Box {
  const scale = Math.min(box.width / image.width, box.height / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  return { left: (box.width - width) / 2, top: (box.height - height) / 2, width, height };
}

/**
 * Where a box in the page (device pixels) sits on a stage the page is drawn into
 * (object-contain). Returned relative to the stage's top left.
 */
export function boxOnStage(box: Box, device: Size, stage: Size): Box {
  const drawn = containRect(stage, device);
  const k = drawn.width / device.width;
  return { left: drawn.left + box.left * k, top: drawn.top + box.top * k, width: box.width * k, height: box.height * k };
}

/**
 * Maps a client point to a device pixel of the remote page. `box` is the canvas
 * element's rect; the page is drawn letterboxed inside it. A point in the margin
 * returns null, so it is not sent, unless `clamp` pins it to the nearest edge
 * (used for a drag or a release that leaves the page).
 */
export function toDevicePoint(clientX: number, clientY: number, box: Box, device: Size, clamp = false): Point | null {
  const drawn = containRect(box, device);
  if (!(drawn.width > 0 && drawn.height > 0)) return null;
  let lx = clientX - box.left - drawn.left;
  let ly = clientY - box.top - drawn.top;
  const outside = lx < 0 || ly < 0 || lx > drawn.width || ly > drawn.height;
  if (outside && !clamp) return null;
  lx = Math.min(Math.max(lx, 0), drawn.width);
  ly = Math.min(Math.max(ly, 0), drawn.height);
  return {
    x: Math.min(device.width - 1, Math.round((lx * device.width) / drawn.width)),
    y: Math.min(device.height - 1, Math.round((ly * device.height) / drawn.height)),
  };
}
