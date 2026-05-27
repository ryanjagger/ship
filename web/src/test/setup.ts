import '@testing-library/jest-dom';

// jsdom lacks ResizeObserver, which Radix UI (tooltips, popovers) relies on.
// Provide a no-op so components that observe element size render in tests.
if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
