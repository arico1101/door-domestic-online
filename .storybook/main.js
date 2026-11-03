const config = {
  stories: ["../storybook/**/*.stories.@(js|mjs)"],
  framework: "@storybook/html-vite",
  staticDirs: [{ from: "../public", to: "/" }],
};

export default config;
