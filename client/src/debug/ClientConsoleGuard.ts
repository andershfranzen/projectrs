if (import.meta.env.PROD && typeof console !== 'undefined') {
  const noop = () => {};
  console.debug = noop;
  console.info = noop;
  console.log = noop;
  console.table = noop;
  console.warn = noop;
  console.error = noop;
}
