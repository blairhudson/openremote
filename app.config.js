const base = require("./app.json");

module.exports = () => {
  if (process.env.APP_VARIANT !== "development") return base;

  return {
    expo: {
      ...base.expo,
      name: "OpenRemote Dev",
      icon: "./assets/icon-dev.png",
      ios: {
        ...base.expo.ios,
        icon: "./assets/icon-dev.png",
        bundleIdentifier: "com.blairhudson.openremote.dev",
      },
      android: {
        ...base.expo.android,
        icon: "./assets/icon-dev.png",
        package: "com.blairhudson.openremote.dev",
      },
    },
  };
};
