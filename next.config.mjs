/** @type {import('next').NextConfig} */
const nextConfig = {
  /* config options here */
  reactCompiler: true,
  // Keep browser-test compilation independent from a developer's live server.
  distDir: process.env.CEV_SIM_NEXT_DIR || ".next",
};

export default nextConfig;
