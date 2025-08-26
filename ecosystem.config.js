module.exports = {
  apps: [
    {
      name: process.env.APP_NAME || "genesys-audio-connector",
      script: "./dist/index.js",
      cwd: process.cwd(),
      instances: process.env.PM2_INSTANCES || 1,
      exec_mode: process.env.PM2_EXEC_MODE || "fork",
      env: {
        NODE_ENV: process.env.NODE_ENV || "production",
      },
      error_file: "./logs/error.log",
      out_file: "./logs/out.log",
      log_file: "./logs/combined.log",
      time: true,
      max_memory_restart: process.env.MAX_MEMORY || "500M",
    },
  ],
};
