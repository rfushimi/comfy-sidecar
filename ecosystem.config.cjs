module.exports = {
  apps: [
    {
      name: "comfy-sidecar",
      script: "dist/index.js",
      exp_backoff_restart_delay: 1000,
      max_restarts: 50,
      env: {
        COMFYUI_URL: "http://127.0.0.1:8188",
        PORT: "19090",
      },
    },
  ],
};
