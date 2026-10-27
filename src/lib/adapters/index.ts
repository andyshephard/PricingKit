// Store adapters for the pricing core's executor. They do network I/O through
// the existing Apple and Google clients, so they live outside src/lib/pricing.
export { AppleAdapter, type AppleAdapterOptions } from './apple';
export { PlayAdapter, type PlayAdapterOptions } from './play';
