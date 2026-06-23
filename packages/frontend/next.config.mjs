/** @type {import('next').NextConfig} */
import path from 'path';

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  experimental: {
    outputFileTracingRoot: path.join(process.cwd(), '../../'),
  },
};

export default nextConfig;
