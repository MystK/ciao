import assert from "assert";
import createDebug from "debug";
import { EventEmitter } from "events";
import deepEqual from "fast-deep-equal";
import net from "net";
import os, { NetworkInterfaceInfo } from "os";
import Timeout = NodeJS.Timeout;

const debug = createDebug("ciao:NetworkManager");

export type InterfaceName = string;
export type MacAddress = string;

export type IPv4Address = string;
export type IPv6Address = string;
export type IPAddress = IPv4Address | IPv6Address;

export const enum IPFamily {
  IPv4 = "IPv4",
  IPv6 = "IPv6",
}

export interface NetworkInterface {
  name: InterfaceName;
  mac: MacAddress;

  // one of ipv4 or ipv6 will be present, most of the time even both
  ipv4?: IPv4Address;
  ipv4Netmask?: IPv4Address;
  ipv6?: IPv6Address; // link-local ipv6
  ipv6Netmask?: IPv6Address;

  routableIpv6?: IPv6Address; // first routable ipv6 address
  routableIpv6Netmask?: IPv6Address;
}

export interface NetworkUpdate {
  added?: NetworkInterface[];
  removed?: NetworkInterface[];
  changes?: InterfaceChange[];
}

export interface InterfaceChange {
  name: InterfaceName;

  outdatedIpv4?: IPv4Address;
  updatedIpv4?: IPv4Address;

  outdatedIpv6?: IPv6Address;
  updatedIpv6?: IPv6Address;

  outdatedRoutableIpv6?: IPv6Address;
  updatedRoutableIpv6?: IPv6Address;
}

export interface NetworkManagerOptions {
  interface?: string | string[];
  excludeIpv6Only?: boolean;
}

export const enum NetworkManagerEvent {
  NETWORK_UPDATE = "network-update",
}

export declare interface NetworkManager {

  on(event: "network-update", listener: (networkUpdate: NetworkUpdate) => void): this;

  emit(event: "network-update", networkUpdate: NetworkUpdate): boolean;

}

export class NetworkManager extends EventEmitter {

  private static readonly POLLING_TIME = 15 * 1000; // 15 seconds

  private readonly restrictedInterfaces?: InterfaceName[];
  private readonly excludeIpv6Only: boolean;

  private readonly currentInterfaces: Map<InterfaceName, NetworkInterface>;

  private currentTimer?: Timeout;

  constructor(options?: NetworkManagerOptions) {
    super();

    if (options && options.interface) {
      if (typeof options.interface === "string" && net.isIP(options.interface)) {
        const interfaceName = NetworkManager.resolveInterface(options.interface);

        if (interfaceName) {
          this.restrictedInterfaces = [interfaceName];
        } else {
          console.log("CIAO: Interface was specified as ip (%s), though couldn't find a matching interface for the given address. " +
            "Going to fallback to bind on all available interfaces.", options.interface);
        }
      } else {
        this.restrictedInterfaces = Array.isArray(options.interface)? options.interface: [options.interface];
      }
    }
    this.excludeIpv6Only = !!(options && options.excludeIpv6Only);

    this.currentInterfaces = this.getCurrentNetworkInterfaces();

    const interfaceNames: InterfaceName[] = [];
    for (const name of this.currentInterfaces.keys()) {
      interfaceNames.push(name);
    }

    if (options) {
      debug("Created NetworkManager (initial networks [%s]; options: %s)", interfaceNames.join(", "), JSON.stringify(options));
    } else {
      debug("Created NetworkManager (initial networks [%s])", interfaceNames.join(", "));
    }

    this.scheduleNextJob();
  }

  public shutdown(): void {
    if (this.currentTimer) {
      clearTimeout(this.currentTimer);
      this.currentTimer = undefined;
    }
  }

  public getInterfaceMap(): Map<InterfaceName, NetworkInterface> {
    return this.currentInterfaces;
  }

  public getInterface(name: InterfaceName): NetworkInterface | undefined {
    return this.currentInterfaces.get(name);
  }

  private scheduleNextJob(): void {
    const timer = setTimeout(this.checkForNewInterfaces.bind(this), NetworkManager.POLLING_TIME);
    timer.unref(); // this timer won't prevent shutdown
  }

  private checkForNewInterfaces(): void {
    debug("Checking for new networks...");

    const latestInterfaces = this.getCurrentNetworkInterfaces();

    let added: NetworkInterface[] | undefined = undefined;
    let removed: NetworkInterface[] | undefined = undefined;
    let changes: InterfaceChange[] | undefined = undefined;

    for (const [name, networkInterface] of latestInterfaces) {
      const currentInterface = this.currentInterfaces.get(name);

      if (currentInterface) { // the interface could potentially have changed
        if (!deepEqual(currentInterface, networkInterface)) {
          // indeed the interface changed
          const change: InterfaceChange = {
            name: name,
          };

          if (currentInterface.ipv4 !== networkInterface.ipv4) { // check for changed ipv4
            if (currentInterface.ipv4) {
              change.outdatedIpv4 = currentInterface.ipv4;
            }
            if (networkInterface.ipv4) {
              change.updatedIpv4 = networkInterface.ipv4;
            }
          }

          if (currentInterface.ipv6 !== networkInterface.ipv6) { // check for changed link-local ipv6
            if (currentInterface.ipv6) {
              change.outdatedIpv6 = currentInterface.ipv6;
            }
            if (networkInterface.ipv6) {
              change.updatedIpv6 = networkInterface.ipv6;
            }
          }

          if (currentInterface.routableIpv6 !== networkInterface.routableIpv6) { // check for changed routable ipv6
            if (currentInterface.routableIpv6) {
              change.outdatedRoutableIpv6 = currentInterface.routableIpv6;
            }
            if (networkInterface.routableIpv6) {
              change.updatedRoutableIpv6 = networkInterface.routableIpv6;
            }
          }

          (changes || (changes = [])) // get or create array
            .push(change);
        }
      } else { // new interface was added/started
        this.currentInterfaces.set(name, networkInterface);

        (added || (added = [])) // get or create array
          .push(networkInterface);
      }
    }

    // at this point we updated any existing interfaces and added all new interfaces
    // thus if the length of below is not the same interface must have been removed
    // this check ensures that we do not unnecessarily loop twice through our interfaces
    if (this.currentInterfaces.size !== latestInterfaces.size) {
      for (const [name, networkInterface] of this.currentInterfaces) {
        if (!latestInterfaces.has(name)) { // interface was removed
          this.currentInterfaces.delete(name);

          (removed || (removed = [])) // get or create new array
            .push(networkInterface);

        }
      }
    }

    if (added || removed || changes) { // emit an event only if anything changed
      const addedString = added? added.map(iface => iface.name).join(","): "";
      const removedString = removed? removed.map(iface => iface.name).join(","): "";
      const changesString = changes? changes.map(iface => {
        let string = `{ name: ${iface.name} `;
        if (iface.outdatedIpv4 || iface.updatedIpv4) {
          string += `, ${iface.outdatedIpv4} -> ${iface.updatedIpv4} `;
        }
        if (iface.outdatedIpv6 || iface.updatedIpv6) {
          string += `, ${iface.outdatedIpv6} -> ${iface.updatedIpv6} `;
        }
        if (iface.outdatedRoutableIpv6 || iface.updatedRoutableIpv6) {
          string += `, ${iface.outdatedRoutableIpv6} -> ${iface.updatedRoutableIpv6} `;
        }
        return string + "}";
      }).join(","): "";

      debug("Detected network changes: added: [%s], removed: [%s], changes: [%s]!", addedString, removedString, changesString);

      this.emit(NetworkManagerEvent.NETWORK_UPDATE, {
        added: added,
        removed: removed,
        changes: changes,
      });
    }

    this.scheduleNextJob();
  }

  private getCurrentNetworkInterfaces(): Map<InterfaceName, NetworkInterface> {
    const interfaces: Map<InterfaceName, NetworkInterface> = new Map();

    Object.entries(os.networkInterfaces()).forEach(([name, infoArray]) => {
      if (!NetworkManager.validNetworkInterfaceName(name)) {
        return;
      }

      if (this.restrictedInterfaces && !this.restrictedInterfaces.includes(name)) {
        return;
      }

      let ipv4Info: NetworkInterfaceInfo | undefined = undefined;
      let ipv6Info: NetworkInterfaceInfo | undefined = undefined;
      let routableIpv6Info: NetworkInterfaceInfo | undefined = undefined;
      let internal = false;

      for (const info of infoArray) {
        if (info.internal) {
          internal = true;
          break;
        }

        if (info.family === "IPv4" && !ipv4Info) {
          ipv4Info = info;
        } else if (info.family === "IPv6") {
          if (info.scopeid && !ipv6Info) { // we only care about non zero scope (aka link-local ipv6)
            ipv6Info = info;
          } else if (info.scopeid === 0 && !routableIpv6Info) { // global routable ipv6
            routableIpv6Info = info;
          }
        }

        if (ipv4Info && ipv6Info && routableIpv6Info) {
          break;
        }
      }

      if (internal) {
        return; // we will not explicitly add the loopback interface
      }

      assert(ipv4Info || ipv6Info, "Could not find valid addresses for interface '" + name + "'");

      if (this.excludeIpv6Only && !ipv4Info) {
        return;
      }

      const networkInterface: NetworkInterface = {
        name: name,
        mac: (ipv4Info?.mac || ipv6Info?.mac)!,
      };

      if (ipv4Info) {
        networkInterface.ipv4 = ipv4Info.address;
        networkInterface.ipv4Netmask = ipv4Info.netmask;
      }

      if (ipv6Info) {
        networkInterface.ipv6 = ipv6Info.address;
        networkInterface.ipv6Netmask = ipv6Info.netmask;
      }

      if (routableIpv6Info) {
        networkInterface.routableIpv6 = routableIpv6Info.address;
        networkInterface.routableIpv6Netmask = routableIpv6Info.netmask;
      }

      interfaces.set(name, networkInterface);
    });

    return interfaces;
  }

  private static validNetworkInterfaceName(name: InterfaceName): boolean {
    // TODO are these all the available names? ip -j -pretty route (linux)
    return os.platform() === "win32" // windows has some weird interface naming, just pass everything for now
      || name.startsWith("en") || name.startsWith("eth") || name.startsWith("wlan") || name.startsWith("wl");
  }

  public static resolveInterface(address: IPAddress): InterfaceName | undefined {
    let interfaceName: InterfaceName | undefined;

    outer: for (const [name, infoArray] of Object.entries(os.networkInterfaces())) {
      for (const info of infoArray) {
        if (info.address === address) {
          interfaceName = name;
          break outer; // exit out of both loops
        }
      }
    }

    return interfaceName;
  }

}
