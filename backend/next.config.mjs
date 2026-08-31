/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      {
        source: '/',
        destination: '/index.html',
      },
      {
        source: '/landing',
        destination: '/index.html',
      },
    ];
  },
};

export default nextConfig;
