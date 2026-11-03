import { MINIMAL_VIEWPORTS } from "storybook/viewport";

const preview = {
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    viewport: {
      options: {
        gameMobile: {
          name: "Game mobile (375 × 812)",
          styles: { width: "375px", height: "812px" },
          type: "mobile",
        },
        gameDesktop: {
          name: "Game desktop (1440 × 900)",
          styles: { width: "1440px", height: "900px" },
          type: "desktop",
        },
        ...MINIMAL_VIEWPORTS,
      },
    },
    options: {
      storySort: { method: "numeric" },
    },
  },
};

export default preview;
