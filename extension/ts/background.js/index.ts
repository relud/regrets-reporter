/* eslint no-unused-vars: ["error", { "varsIgnorePattern": "(extensionGlue)" }]*/

import { browser } from "webextension-polyfill-ts";
import {
  CookieInstrument,
  JavascriptInstrument,
  HttpInstrument,
  NavigationInstrument,
} from "@openwpm/webext-instrumentation";
import { ReportSummarizer } from "./ReportSummarizer";
import { triggerClientDownloadOfData } from "./lib/triggerClientDownloadOfData";
import {
  NavigationBatch,
  TrimmedNavigationBatch,
} from "./NavigationBatchPreprocessor";
import { YouTubeUsageStatistics } from "./YouTubeUsageStatistics";
import { OpenWpmPacketHandler } from "./openWpmPacketHandler";
import { DataSharer } from "./DataSharer";
import { Store } from "./Store";
import { localStorageWrapper } from "./lib/localStorageWrapper";
const openWpmPacketHandler = new OpenWpmPacketHandler();
const reportSummarizer = new ReportSummarizer();
const store = new Store(localStorageWrapper);
const youTubeUsageStatistics = new YouTubeUsageStatistics(store);
const dataSharer = new DataSharer(store);

class ExtensionGlue {
  private navigationInstrument: NavigationInstrument;
  private cookieInstrument: CookieInstrument;
  private jsInstrument: JavascriptInstrument;
  private httpInstrument: HttpInstrument;
  private openwpmCrawlId: string;
  private contentScriptPortListener;

  constructor() {}

  async init() {
    // Set up a connection / listener for the consent-form script to be able to query consent status
    let portFromContentScript;
    this.contentScriptPortListener = p => {
      if (p.name !== "port-from-consent-form") {
        return;
      }
      console.log("Connected to consent-form script");
      portFromContentScript = p;
      portFromContentScript.onMessage.addListener(async function(m) {
        console.log("Message from consent-form script:", { m });
        if (m.requestConsentStatus) {
          portFromContentScript.postMessage({
            consentStatus: await store.getConsentStatus(),
            consentStatusTimestamp: await store.getConsentStatusTimestamp(),
          });
        }
        if (m.updatedConsentStatus) {
          const { userOver18, userPartOfMarginalizedGroup } = m;
          await store.setConsentStatus(m.updatedConsentStatus);
          await store.setUserSuppliedDemographics({
            user_over_18: userOver18,
            user_part_of_marginalized_group: userPartOfMarginalizedGroup,
          });
          const consentGiven = (await store.getConsentStatus()) === "given";
          if (consentGiven) {
            console.log("Enrolled. Starting study");
            await dataSharer.share({
              data_sharing_consent_update: {
                consent_status: await store.getConsentStatus(),
                consent_status_timestamp: await store.getConsentStatusTimestamp(),
              },
            });
            await extensionGlue.start();
          }
        }
      });
    };
    browser.runtime.onConnect.addListener(this.contentScriptPortListener);
  }

  async askForConsent() {
    // Open consent form
    const consentFormUrl = browser.runtime.getURL(
      `consent-form/consent-form.html`,
    );
    await browser.tabs.create({ url: consentFormUrl });
  }

  async start() {
    // During prototype phase, we have a browser action button that allows for downloading the reported data
    const exportSharedData = async () => {
      console.debug("Exporting shared data");
      const sharedData = await dataSharer.export();
      await triggerClientDownloadOfData(
        sharedData,
        `youTubeRegretsReporter-sharedData-userUuid=${await store.extensionInstallationUuid()}.json`,
      );
    };
    browser.browserAction.onClicked.addListener(exportSharedData);

    // Only show report-regret page action on YouTube watch pages
    const showPageActionOnWatchPagesOnly = (tabId, changeInfo, tab) => {
      if (
        tab.url.match(
          /:\/\/[^\/]*\.?(youtube.com|youtu.be|youtube-nocookies.com)\/watch/,
        )
      ) {
        browser.pageAction.show(tab.id);
      } else {
        browser.pageAction.hide(tab.id);
      }
    };
    browser.tabs.onUpdated.addListener(showPageActionOnWatchPagesOnly);

    // Make the page action show on watch pages also in case extension is loaded/reloaded while on one
    const activeTabs = await browser.tabs.query({
      active: true,
    });
    if (activeTabs.length > 0) {
      const currentTab = activeTabs[0];
      showPageActionOnWatchPagesOnly(currentTab.id, null, currentTab);
    }

    // Set up a connection / listener for content scripts to be able to query collected web traffic data
    let portFromContentScript;
    this.contentScriptPortListener = p => {
      if (p.name !== "port-from-report-regret-form") {
        return;
      }
      portFromContentScript = p;
      portFromContentScript.onMessage.addListener(async function(m) {
        console.log("Message from report-regret-form script:", { m });
        if (m.regretReport) {
          const { regretReport } = m;
          // Share the reported regret
          dataSharer.share({ regret_report: regretReport });
          console.log("Reported regret shared");
        }
        // The report form has triggered a report-related data collection
        if (m.requestRegretReportData) {
          try {
            await openWpmPacketHandler.navigationBatchPreprocessor.processQueue();
            const youTubeNavigations = await reportSummarizer.navigationBatchesByUuidToYouTubeNavigations(
              openWpmPacketHandler.navigationBatchPreprocessor
                .navigationBatchesByNavigationUuid,
            );
            const regretReportData = await reportSummarizer.regretReportDataFromYouTubeNavigations(
              youTubeNavigations,
            );
            portFromContentScript.postMessage({
              regretReportData,
            });
          } catch (error) {
            console.error(
              "Error encountered during regret report data processing",
              error,
            );
            portFromContentScript.postMessage({
              errorMessage: error.message,
            });
          }
        }
      });
    };
    browser.runtime.onConnect.addListener(this.contentScriptPortListener);

    // Set up the active tab dwell time monitor
    openWpmPacketHandler.activeTabDwellTimeMonitor.run();

    // Add hooks to the navigation batch preprocessor
    openWpmPacketHandler.navigationBatchPreprocessor.processedNavigationBatchTrimmer = async (
      navigationBatch: NavigationBatch,
    ): Promise<TrimmedNavigationBatch> => {
      // Keep track of aggregated statistics
      await youTubeUsageStatistics.seenNavigationBatch(navigationBatch);

      // trim away irrelevant parts of the batch (decreases memory usage)
      // TODO
      return reportSummarizer.trimNavigationBatch(navigationBatch);
    };

    // Start the navigation batch preprocessor
    await openWpmPacketHandler.navigationBatchPreprocessor.run();

    // Start OpenWPM instrumentation (monitors navigations and http content)
    const openwpmConfig = {
      navigation_instrument: true,
      cookie_instrument: false,
      js_instrument: false,
      http_instrument: true,
      save_content: "main_frame,xmlhttprequest",
      http_instrument_resource_types: "main_frame,xmlhttprequest",
      http_instrument_urls:
        "*://*.youtube.com/*|*://*.youtu.be/*|*://*.youtube-nocookie.com/*",
      crawl_id: 0,
    };
    await this.startOpenWPMInstrumentation(openwpmConfig);

    // Periodic submission of YouTube usage statistics
    await youTubeUsageStatistics.run(dataSharer);
  }

  async startOpenWPMInstrumentation(config) {
    this.openwpmCrawlId = config["crawl_id"];
    if (config["navigation_instrument"]) {
      await openWpmPacketHandler.logDebug("Navigation instrumentation enabled");
      this.navigationInstrument = new NavigationInstrument(
        openWpmPacketHandler,
      );
      this.navigationInstrument.run(config["crawl_id"]);
    }
    if (config["cookie_instrument"]) {
      await openWpmPacketHandler.logDebug("Cookie instrumentation enabled");
      this.cookieInstrument = new CookieInstrument(openWpmPacketHandler);
      this.cookieInstrument.run(config["crawl_id"]);
    }
    if (config["js_instrument"]) {
      await openWpmPacketHandler.logDebug("Javascript instrumentation enabled");
      this.jsInstrument = new JavascriptInstrument(openWpmPacketHandler);
      this.jsInstrument.run(config["crawl_id"]);
    }
    if (config["http_instrument"]) {
      await openWpmPacketHandler.logDebug("HTTP Instrumentation enabled");
      this.httpInstrument = new HttpInstrument(openWpmPacketHandler);
      this.httpInstrument.run(
        config["crawl_id"],
        config["save_content"],
        config["http_instrument_resource_types"],
        config["http_instrument_urls"],
      );
    }
  }

  pause() {
    openWpmPacketHandler.pause();
    if (openWpmPacketHandler.activeTabDwellTimeMonitor) {
      openWpmPacketHandler.activeTabDwellTimeMonitor.cleanup();
    }
    if (openWpmPacketHandler.navigationBatchPreprocessor) {
      openWpmPacketHandler.navigationBatchPreprocessor.cleanup();
    }
  }

  resume() {
    openWpmPacketHandler.resume();
    if (openWpmPacketHandler.activeTabDwellTimeMonitor) {
      openWpmPacketHandler.activeTabDwellTimeMonitor.run();
    }
    if (openWpmPacketHandler.navigationBatchPreprocessor) {
      openWpmPacketHandler.navigationBatchPreprocessor.run();
    }
  }

  /**
   * Called at end of study, and if the user disables the study or it gets uninstalled by other means.
   */
  async cleanup() {
    if (this.contentScriptPortListener) {
      browser.runtime.onMessage.removeListener(this.contentScriptPortListener);
    }
    if (this.navigationInstrument) {
      await this.navigationInstrument.cleanup();
    }
    if (this.cookieInstrument) {
      await this.cookieInstrument.cleanup();
    }
    if (this.jsInstrument) {
      await this.jsInstrument.cleanup();
    }
    if (this.httpInstrument) {
      await this.httpInstrument.cleanup();
    }
    if (openWpmPacketHandler.activeTabDwellTimeMonitor) {
      openWpmPacketHandler.activeTabDwellTimeMonitor.cleanup();
    }
    if (openWpmPacketHandler.navigationBatchPreprocessor) {
      await openWpmPacketHandler.navigationBatchPreprocessor.cleanup();
    }
    if (openWpmPacketHandler.navigationBatchPreprocessor) {
      await youTubeUsageStatistics.cleanup();
    }
  }
}

// make an instance of the ExtensionGlue class available to the extension background context
const extensionGlue = ((window as any).extensionGlue = new ExtensionGlue());

// make the openWpmPacketHandler singleton and triggerClientDownloadOfData available to
// the extension background context so that we as developers can collect fixture data
(window as any).openWpmPacketHandler = openWpmPacketHandler;
(window as any).triggerClientDownloadOfData = triggerClientDownloadOfData;

// init the extension glue on every extension load
async function onEveryExtensionLoad() {
  const consentGiven = (await store.getConsentStatus()) === "given";
  await extensionGlue.init();
  if (consentGiven) {
    await extensionGlue.start();
  } else {
    await extensionGlue.askForConsent();
  }
}
onEveryExtensionLoad().then();
