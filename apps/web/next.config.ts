import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The domain package is consumed as TypeScript source.
  transpilePackages: ['@dayson/domain'],
  // Monorepo root, so file tracing and Turbopack see packages/domain.
  outputFileTracingRoot: path.join(__dirname, '..', '..'),
  turbopack: { root: path.join(__dirname, '..', '..') },
  async headers() {
    return [
      {
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Service-Worker-Allowed', value: '/floor' },
        ],
      },
    ];
  },
};

export default nextConfig;
