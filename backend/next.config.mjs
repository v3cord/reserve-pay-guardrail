/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      {
        source: '/landing',
        destination: '/landing/index.html',
      },
    ];
  },
};

export default nextConfig;
