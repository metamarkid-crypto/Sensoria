/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // QRIS image upload (/admin/payment): a PNG/JPEG up to 5 MB crosses a
    // server action before it is forwarded multipart to qris-api — which
    // caps the same file at 5 MB in decodeQris.js.
    serverActions: { bodySizeLimit: "6mb" },
  },
};

export default nextConfig;
