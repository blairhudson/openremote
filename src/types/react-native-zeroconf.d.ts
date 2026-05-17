declare module "react-native-zeroconf" {
  export default class Zeroconf {
    on(event: "start" | "stop" | "update", handler: () => void): void;
    on(event: "found" | "remove", handler: (name: string) => void): void;
    on(event: "resolved", handler: (service: unknown) => void): void;
    on(event: "error", handler: (error: unknown) => void): void;
    scan(type?: string, protocol?: string, domain?: string, implType?: string): void;
    stop(implType?: string): void;
    removeDeviceListeners(): void;
  }
}
