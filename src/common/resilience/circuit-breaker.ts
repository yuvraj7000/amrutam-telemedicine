import CircuitBreaker from 'opossum';

export const PAYMENT_CIRCUIT_BREAKER_OPTIONS: CircuitBreaker.Options = {
  timeout: 3000,
  errorThresholdPercentage: 50,
  volumeThreshold: 10,
  resetTimeout: 30000,
};

export function createCircuitBreaker<TArgs extends unknown[], TResult>(
  action: (...args: TArgs) => Promise<TResult>,
  options: CircuitBreaker.Options = PAYMENT_CIRCUIT_BREAKER_OPTIONS,
): CircuitBreaker<TArgs, TResult> {
  return new CircuitBreaker(action, options);
}
