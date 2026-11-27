import { subscriptionSettings } from '../../server/core/config.ts';
import { SUBSCRIPTION_DEFAULTS } from '../../server/core/defaults.ts';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('subscriptionSettings', () => {
  it('falls back to the defaults, and takes positive whole numbers from the environment', () => {
    expect(subscriptionSettings()).toEqual(SUBSCRIPTION_DEFAULTS);
    vi.stubEnv('SUBSCRIPTION_MAX_STREAMS', '10');
    expect(subscriptionSettings().maxStreams).toBe(10);
  });

  it.each(['0', '-5', '1.5', 'lots'])('refuses %s', (raw) => {
    vi.stubEnv('SUBSCRIPTION_IDLE_TIMEOUT_SECONDS', raw);
    expect(() => subscriptionSettings()).toThrow(/whole number/);
  });
});
