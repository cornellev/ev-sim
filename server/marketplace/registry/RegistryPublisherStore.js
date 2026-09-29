import { assertMarketplacePublisher, marketplaceDocumentBytes, parseMarketplaceDocument } from "../MarketplaceContracts.js";
import { MARKETPLACE_ERROR_CODES, marketplaceError } from "../MarketplaceErrors.js";

export class RegistryPublisherStore {
    constructor(store) {
        this.store = store;
    }

    async getPublisher(publisherId, catalog = null) {
        const current = catalog ?? await this.store.readCatalog();
        const summary = (current.publishers ?? []).find((entry) => entry.publisherId === publisherId);
        if (!summary) return null;
        const { document, bytes } = await this.store.readTarget(summary.target);
        const publisher = assertMarketplacePublisher(document);
        if (publisher.publisherId !== publisherId || !Buffer.from(marketplaceDocumentBytes(publisher)).equals(bytes)) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Publisher target does not match its catalog identity.");
        }
        return publisher;
    }

    async listPublishers(catalog = null) {
        const current = catalog ?? await this.store.readCatalog();
        const publishers = [];
        for (const summary of current.publishers ?? []) publishers.push(await this.getPublisher(summary.publisherId, current));
        return publishers;
    }

    parse(rawBytes) {
        return assertMarketplacePublisher(parseMarketplaceDocument(rawBytes));
    }
}
