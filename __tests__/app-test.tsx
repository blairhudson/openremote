import { render, screen } from "@testing-library/react-native";

import App from "../App";

test("app renders connect screen", () => {
  render(<App />);

  expect(screen.getByText(/searching for servers/)).toBeTruthy();
  expect(screen.getByText("connect")).toBeTruthy();
});
