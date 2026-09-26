module.exports = {
  apps: [
    {
      name: "ai-assistant",
      cwd: "/var/www/html/Evolv-Application/ai-assistant/backend",
      script: "dist/server.js",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        PORT: "5050",
        BIND_HOST: "0.0.0.0",
      },
    },
  ],
};
