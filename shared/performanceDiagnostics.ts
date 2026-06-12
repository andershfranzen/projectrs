export interface FramePacingSample {
  intervals: number;
  meanMs: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
  stddevMs: number;
  over16Ms: number;
  over33Ms: number;
  over50Ms: number;
  over100Ms: number;
}

export type PerformanceDiagnosticClass =
  | 'software-low'
  | 'stable-30'
  | 'stalls'
  | 'hardware-low'
  | 'low-fps'
  | 'healthy-high'
  | 'healthy'
  | 'unclear';

export const SOFTWARE_RENDERER_PATTERNS = [
  'swiftshader',
  'llvmpipe',
  'software rasterizer',
  'software renderer',
  'microsoft basic render',
  'basic render driver',
  'warp',
  'mesa offscreen',
] as const;

export function finiteDiagnosticNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function isPlainDiagnosticRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function diagnosticRecordField(record: unknown, key: string): Record<string, unknown> {
  return isPlainDiagnosticRecord(record) && isPlainDiagnosticRecord(record[key])
    ? record[key] as Record<string, unknown>
    : {};
}

export function diagnosticFlagsFromPayload(payload: unknown): string[] {
  const flags = isPlainDiagnosticRecord(payload) ? payload.diagnosticFlags : null;
  return Array.isArray(flags) ? flags.filter((flag): flag is string => typeof flag === 'string') : [];
}

export function measuredFpsFromDiagnosticPayload(payload: unknown): number | null {
  if (!isPlainDiagnosticRecord(payload)) return null;
  return finiteDiagnosticNumber(payload.measuredFps)
    ?? finiteDiagnosticNumber(payload.fps)
    ?? finiteDiagnosticNumber(payload.engineFps);
}

function roundDiagnosticTiming(value: number): number {
  return Math.round(value * 10) / 10;
}

export function summarizeFramePacing(intervals: readonly number[]): FramePacingSample | null {
  if (intervals.length === 0) return null;
  const sorted = [...intervals].sort((a, b) => a - b);
  const percentile = (p: number): number => {
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
    return sorted[index];
  };
  const sum = intervals.reduce((total, value) => total + value, 0);
  const mean = sum / intervals.length;
  const variance = intervals.reduce((total, value) => total + ((value - mean) ** 2), 0) / intervals.length;

  return {
    intervals: intervals.length,
    meanMs: roundDiagnosticTiming(mean),
    medianMs: roundDiagnosticTiming(percentile(0.5)),
    p95Ms: roundDiagnosticTiming(percentile(0.95)),
    maxMs: roundDiagnosticTiming(sorted[sorted.length - 1]),
    stddevMs: roundDiagnosticTiming(Math.sqrt(variance)),
    over16Ms: intervals.filter(value => value > 16.7).length,
    over33Ms: intervals.filter(value => value > 33.4).length,
    over50Ms: intervals.filter(value => value > 50).length,
    over100Ms: intervals.filter(value => value > 100).length,
  };
}

export function framePacingFromDiagnosticPayload(payload: unknown): Record<string, unknown> | null {
  return isPlainDiagnosticRecord(payload) && isPlainDiagnosticRecord(payload.framePacing)
    ? payload.framePacing
    : null;
}

export function isStableLowFrameCadence(fps: unknown, pacing: unknown): boolean {
  const measuredFps = finiteDiagnosticNumber(fps);
  const record = isPlainDiagnosticRecord(pacing) ? pacing : null;
  const median = finiteDiagnosticNumber(record?.medianMs);
  const p95 = finiteDiagnosticNumber(record?.p95Ms);
  const stddev = finiteDiagnosticNumber(record?.stddevMs);
  return measuredFps !== null
    && measuredFps >= 27
    && measuredFps <= 36
    && median !== null
    && median >= 27
    && median <= 38
    && p95 !== null
    && p95 <= 42
    && stddev !== null
    && stddev <= 5;
}

export function hasUnevenFramePacing(pacing: unknown): boolean {
  const record = isPlainDiagnosticRecord(pacing) ? pacing : null;
  const p95 = finiteDiagnosticNumber(record?.p95Ms);
  const max = finiteDiagnosticNumber(record?.maxMs);
  const stddev = finiteDiagnosticNumber(record?.stddevMs);
  const over50 = finiteDiagnosticNumber(record?.over50Ms);
  return (p95 !== null && p95 >= 50)
    || (max !== null && max >= 100)
    || (stddev !== null && stddev >= 12)
    || (over50 !== null && over50 >= 3);
}

export function rendererFromWebGlDiagnostics(webgl: unknown): string {
  const info = isPlainDiagnosticRecord(webgl) ? webgl : {};
  return String(info.unmaskedRenderer ?? info.renderer ?? 'unknown');
}

export function isSoftwareRendererText(...values: unknown[]): boolean {
  const text = values.filter(Boolean).join(' ').toLowerCase();
  return SOFTWARE_RENDERER_PATTERNS.some((pattern) => text.includes(pattern));
}

export function isSoftwareWebGlRenderer(webgl: unknown): boolean {
  const info = isPlainDiagnosticRecord(webgl) ? webgl : {};
  return isSoftwareRendererText(
    info.unmaskedRenderer,
    info.renderer,
    info.unmaskedVendor,
    info.vendor,
  );
}

function browserDiagnosticsAux(browserDiagnostics: unknown): Record<string, unknown> {
  return diagnosticRecordField(
    diagnosticRecordField(diagnosticRecordField(browserDiagnostics, 'systemInfo'), 'gpu'),
    'auxAttributes',
  );
}

export function isSoftwarePerformanceDiagnostic(payload: unknown, browserDiagnostics: unknown = null): boolean {
  if (!isPlainDiagnosticRecord(payload)) return false;
  if (diagnosticFlagsFromPayload(payload).includes('software-renderer-likely')) return true;
  const aux = browserDiagnosticsAux(browserDiagnostics);
  return isSoftwareRendererText(
    rendererFromWebGlDiagnostics(payload.webgl),
    aux.glRenderer,
    aux.glVendor,
    aux.angleBackend,
  );
}

export function browserFamilyFromDiagnosticPayload(payload: unknown): string {
  const browser = diagnosticRecordField(payload, 'browser');
  const flags = diagnosticFlagsFromPayload(payload);
  if (browser.brave === true || flags.includes('brave-browser')) return 'Brave';
  const ua = String(browser.userAgent ?? '');
  if (ua.includes('Edg/')) return 'Edge';
  if (ua.includes('HeadlessChrome/')) return 'HeadlessChrome';
  if (ua.includes('Chrome/')) return 'Chrome';
  if (ua.includes('Chromium/')) return 'Chromium';
  const uaData = diagnosticRecordField(browser, 'userAgentData');
  const brands = uaData.brands;
  if (Array.isArray(brands)) {
    const brandNames = brands
      .map(brand => isPlainDiagnosticRecord(brand) ? String(brand.brand ?? '') : '')
      .filter(Boolean);
    if (brandNames.some(brand => brand.includes('Microsoft Edge'))) return 'Edge';
    if (brandNames.some(brand => brand.includes('Google Chrome'))) return 'Chrome';
    if (brandNames.some(brand => brand.includes('Chromium'))) return 'Chromium';
    if (brandNames.length > 0) return brandNames.join(', ');
  }
  return String(browser.platform ?? 'unknown');
}

export function isPlayerChromiumBrowserFamily(family: string): boolean {
  return family === 'Chrome'
    || family === 'Brave'
    || family === 'Edge'
    || family === 'Chromium';
}

export function diagnosticMapLabel(payload: unknown): string {
  return isPlainDiagnosticRecord(payload) ? String(payload.currentMap ?? 'n/a') : 'n/a';
}

export function diagnosticFloorLabel(payload: unknown): string {
  return isPlainDiagnosticRecord(payload) && payload.currentFloor != null ? String(payload.currentFloor) : 'n/a';
}

export function diagnosticRatioDelta(a: unknown, b: unknown): number | null {
  const left = finiteDiagnosticNumber(a);
  const right = finiteDiagnosticNumber(b);
  if (left === null || right === null) return null;
  const larger = Math.max(Math.abs(left), Math.abs(right));
  if (larger === 0) return 0;
  return Math.abs(left - right) / larger;
}

export function areComparableDiagnosticScenes(aPayload: unknown, bPayload: unknown): boolean {
  const aMap = diagnosticMapLabel(aPayload);
  const bMap = diagnosticMapLabel(bPayload);
  if (aMap !== 'n/a' && bMap !== 'n/a' && aMap !== bMap) return false;
  const aFloor = diagnosticFloorLabel(aPayload);
  const bFloor = diagnosticFloorLabel(bPayload);
  if (aFloor !== 'n/a' && bFloor !== 'n/a' && aFloor !== bFloor) return false;

  const a = isPlainDiagnosticRecord(aPayload) ? aPayload : {};
  const b = isPlainDiagnosticRecord(bPayload) ? bPayload : {};
  const meshDelta = diagnosticRatioDelta(a.activeMeshes, b.activeMeshes);
  const vertexDelta = diagnosticRatioDelta(a.totalVertices, b.totalVertices);
  return (meshDelta === null || meshDelta <= 0.35)
    && (vertexDelta === null || vertexDelta <= 0.35);
}

export function diagnosticSceneComparisonText(aPayload: unknown, bPayload: unknown): string {
  const a = isPlainDiagnosticRecord(aPayload) ? aPayload : {};
  const b = isPlainDiagnosticRecord(bPayload) ? bPayload : {};
  const meshDelta = diagnosticRatioDelta(a.activeMeshes, b.activeMeshes);
  const vertexDelta = diagnosticRatioDelta(a.totalVertices, b.totalVertices);
  const aMap = diagnosticMapLabel(aPayload);
  const bMap = diagnosticMapLabel(bPayload);
  const parts = [
    `map ${aMap === bMap ? aMap : `${aMap} vs ${bMap}`}`,
    meshDelta === null ? null : `meshes ${Math.round(meshDelta * 100)}% apart`,
    vertexDelta === null ? null : `vertices ${Math.round(vertexDelta * 100)}% apart`,
  ].filter(Boolean);
  return parts.join(', ');
}

export function classifyPerformanceDiagnostic(
  payload: unknown,
  browserDiagnostics: unknown = null,
): PerformanceDiagnosticClass {
  const fps = measuredFpsFromDiagnosticPayload(payload);
  const pacing = framePacingFromDiagnosticPayload(payload);
  const flags = diagnosticFlagsFromPayload(payload);
  if (isSoftwarePerformanceDiagnostic(payload, browserDiagnostics) && fps !== null && fps < 55) return 'software-low';
  if (isStableLowFrameCadence(fps, pacing)) return 'stable-30';
  if (fps !== null && fps < 55 && hasUnevenFramePacing(pacing)) return 'stalls';
  if (flags.includes('brave-low-fps') || flags.includes('low-fps-with-hardware-renderer')) return 'hardware-low';
  if (fps !== null && fps < 55) return 'low-fps';
  if (fps !== null && fps >= 100) return 'healthy-high';
  if (fps !== null && fps >= 55) return 'healthy';
  return 'unclear';
}
