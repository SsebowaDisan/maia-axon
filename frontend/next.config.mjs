/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: "http",
        hostname: "**"
      },
      {
        protocol: "https",
        hostname: "**"
      }
    ]
  },
  webpack: (config) => {
    // pdfjs-dist conditionally requires @napi-rs/canvas (Node-only) at
    // module scope; aliasing it to `false` tells webpack to leave it as
    // an empty stub in the browser bundle. Standard react-pdf fix.
    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      canvas: false,
      encoding: false
    };
    return config;
  }
};

export default nextConfig;
