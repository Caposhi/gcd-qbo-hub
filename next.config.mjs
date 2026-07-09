/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The /console/* stream route uses the Node runtime for long-lived SSE.
  experimental: {
    serverComponentsExternalPackages: ["@prisma/client", "googleapis", "google-auth-library"],
  },
};

export default nextConfig;
