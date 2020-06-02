import { Storage } from "webextension-polyfill-ts";
import StorageArea = Storage.StorageArea;
import StorageAreaSetItemsType = Storage.StorageAreaSetItemsType;
import { makeUUID } from "./lib/uuid";

export interface LocalStorageWrapper {
  get: StorageArea["get"];
  set: StorageArea["set"];
}

export interface UserSuppliedDemographics {
  dem_age: "" | string;
  dem_gender: "" | "man" | "woman" | "other-description" | string;
  dem_gender_descr: "" | string;
  last_updated: "" | string;
}

export type ConsentStatus = null | "given" | "withdrawn";

export interface ExtensionPreferences {
  enableErrorReporting: boolean;
}

export const defaultExtensionPreferences = {
  enableErrorReporting: true,
};

export class Store implements LocalStorageWrapper {
  public localStorageWrapper: LocalStorageWrapper;
  constructor(localStorageWrapper) {
    this.get = localStorageWrapper.get;
    this.set = localStorageWrapper.set;
  }
  get = async (
    keys?:
      | null
      | string
      | string[]
      | {
          [s: string]: any;
        },
  ): Promise<{
    [s: string]: any;
  }> => ({});
  set = async (items: StorageAreaSetItemsType): Promise<void> => {};

  /**
   * Returns a persistent unique identifier of the extension installation
   * sent with each report. Not related to the Firefox client id
   */
  extensionInstallationUuid = async () => {
    const { extensionInstallationUuid } = await this.get(
      "extensionInstallationUuid",
    );
    if (extensionInstallationUuid) {
      return extensionInstallationUuid;
    }
    const generatedUuid = makeUUID();
    await this.set({ extensionInstallationUuid: generatedUuid });
    return generatedUuid;
  };

  getExtensionPreferences = async (): Promise<ExtensionPreferences> => {
    const { extensionPreferences } = await this.get("extensionPreferences");
    return {
      ...defaultExtensionPreferences,
      ...extensionPreferences,
    };
  };

  setExtensionPreferences = async (
    extensionPreferences: ExtensionPreferences,
  ) => {
    await this.set({ extensionPreferences });
  };

  getUserSuppliedDemographics = async (): Promise<UserSuppliedDemographics> => {
    const { userSuppliedDemographics } = await this.get(
      "userSuppliedDemographics",
    );
    return (
      userSuppliedDemographics || {
        dem_age: "",
        dem_gender: "",
        dem_gender_descr: "",
        last_updated: "",
      }
    );
  };

  setUserSuppliedDemographics = async (
    userSuppliedDemographics: UserSuppliedDemographics,
  ) => {
    await this.set({ userSuppliedDemographics });
  };
}
