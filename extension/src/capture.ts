import { resolveFrame, send } from './cdp.js';
import { ToolError } from './errors.js';
import { evaluate } from './snapshot.js';

// The viewport as the model sees it. Wide viewports are shrunk so a full
// screenshot fits the image budget; every coordinate the model sends or reads
// is in this frame, not in CSS pixels.
export interface View {
  cssWidth: number;
  cssHeight: number;
  dpr: number;
  pageX: number;
  pageY: number;
  // Frame pixels per CSS pixel.
  ratio: number;
  width: number;
  height: number;
}

export interface Shot {
  data: string;
  mimeType: string;
  width: number;
  height: number;
}

const MAX_EDGE = 1_568;

export async function viewOf(tabId: number): Promise<View> {
  const [cssWidth, cssHeight, dpr] = await evaluate<[number, number, number]>(
    await resolveFrame(tabId),
    '[window.innerWidth, window.innerHeight, window.devicePixelRatio]',
  );
  const { cssVisualViewport: visual } = await send({ tabId }, 'Page.getLayoutMetrics');
  const ratio = Math.min(1, MAX_EDGE / Math.max(cssWidth, cssHeight));

  return {
    cssWidth,
    cssHeight,
    dpr,
    pageX: visual.pageX,
    pageY: visual.pageY,
    ratio,
    width: Math.round(cssWidth * ratio),
    height: Math.round(cssHeight * ratio),
  };
}

export async function captureViewport(tabId: number, view: View, scale = 1): Promise<Shot> {
  const { data } = await send({ tabId }, 'Page.captureScreenshot', {
    format: 'jpeg',
    quality: 80,
    clip: {
      x: view.pageX,
      y: view.pageY,
      width: view.cssWidth,
      height: view.cssHeight,
      // clip.scale 1 would give device pixels.
      scale: (view.ratio * scale) / view.dpr,
    },
  });

  return {
    data,
    mimeType: 'image/jpeg',
    width: Math.round(view.width * scale),
    height: Math.round(view.height * scale),
  };
}

// Captures a rectangle given in frame coordinates at device resolution, so
// small text comes back magnified.
export async function captureRegion(
  tabId: number,
  view: View,
  region: [number, number, number, number],
  scale = 1,
): Promise<Shot> {
  const [x0, y0, x1, y1] = region.map((value) => value / view.ratio) as [number, number, number, number];
  const width = x1 - x0;
  const height = y1 - y0;

  if (!(width > 0 && height > 0)) {
    throw new ToolError('BAD_ARGS', 'region must be [x0, y0, x1, y1] with x1 > x0 and y1 > y0.');
  }

  const factor = Math.min(scale, MAX_EDGE / (Math.max(width, height) * view.dpr));

  const { data } = await send({ tabId }, 'Page.captureScreenshot', {
    format: 'png',
    clip: { x: x0 + view.pageX, y: y0 + view.pageY, width, height, scale: factor },
  });

  return {
    data,
    mimeType: 'image/png',
    width: Math.round(width * view.dpr * factor),
    height: Math.round(height * view.dpr * factor),
  };
}
