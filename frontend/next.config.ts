import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ['192.168.0.4', '192.168.0.4:3000', 'localhost', 'localhost:3000']
};

export default nextConfig;
