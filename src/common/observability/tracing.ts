import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { Resource } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';

import { env } from '../../config/env.js';

let sdk: NodeSDK | undefined;

export function startTracing(): NodeSDK {
  if (sdk) return sdk;
  sdk = new NodeSDK({
    resource: new Resource({ 'service.name': env.OTEL_SERVICE_NAME }),
    traceExporter: new OTLPTraceExporter({ url: `${env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces` }),
  });
  registerInstrumentations({ instrumentations: [] });
  void sdk.start();
  return sdk;
}

export async function stopTracing(): Promise<void> {
  await sdk?.shutdown();
}
