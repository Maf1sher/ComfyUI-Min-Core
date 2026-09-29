export interface GalleryCollection {
    id: string;
    name: string;
}

export interface GalleryRecordSummary {
    id: string;
    name: string;
    collection_id: string;
    general_tags: string;
    person_tags: string[];
    mask_count: number;
    has_image: boolean;
    created: string;
    pose_person_count?: number | null;
}

export interface GalleryRecord extends GalleryRecordSummary {
    pose_json: string;
    assets: {
        image: string | null;
        pose: string;
        masks: string[];
    };
}

export interface GalleryPanelState {
    node: any;
    panel: any;
    backdrop: HTMLElement;
    root: HTMLElement;
    collections: GalleryCollection[];
    records: GalleryRecordSummary[];
    recordsPage: number;
    recordsStatus: "loading" | "ready" | "error";
    recordsError: string | null;
    recordsRequestId: number;
    collectionsRequestId: number;
    selectionRequestId: number;
    selectedRecordIds: Set<string>;
    selectionPending: boolean;
    selectionTargetRecordId: string | null;
    deletingRecordId: string | null;
    movingRecordId: string | null;
    bulkOperation: "delete" | "move" | null;
    deletingCollectionId: string | null;
    usingRecord: boolean;
    retryCollections: boolean;
    selectedRecord: GalleryRecord | null;
    selectedCollection: string;
    viewMode: "medium" | "large" | "tiles";
    thumbnailLayerVisibility: Record<string, boolean>;
    thumbnailImageCache: Map<string, Promise<HTMLImageElement | null>>;
    previewImages: HTMLImageElement[];
    previewLayers: Array<Record<string, any>>;
    maskPreviewCanvases: Map<string, HTMLCanvasElement>;
    previewLayerVisibility: Record<string, boolean>;
    persistLayerVisibility: () => void;
    previewLineWidth: number;
    posePreviewRequestId: number;
    posePreviewTimer: number | null;
    previewExpanded: boolean;
    previewRevision?: number;
    previewReturnFocus: any;
    settingsOpen: boolean;
    settingsReturnFocus: any;
    deleteConfirmOpen: boolean;
    deleteConfirmReturnFocus: any;
    pendingDeleteRecords: GalleryRecordSummary[];
    moveDialogOpen: boolean;
    moveDialogReturnFocus: any;
    pendingMoveRecords: GalleryRecordSummary[];
    deleteCollectionConfirmOpen: boolean;
    deleteCollectionConfirmReturnFocus: any;
    pendingDeleteCollection: GalleryCollection | null;
    newCollectionDialogOpen: boolean;
    newCollectionDialogReturnFocus: any;
    saveDialogOpen: boolean;
    saveDialogReturnFocus: any;
    savingRecord: boolean;
    saveQueued: boolean;
    loadingCurrentInputs: boolean;
    showingCurrentInputs: boolean;
    thumbnailObserver: IntersectionObserver | null;
    restoreFocus: any;
    resizeHandler: (() => void) | null;
    keydownHandler: ((event: KeyboardEvent) => void) | null;
    searchTimer: number | null;
    closing: boolean;
}

export interface GalleryPanelActions {
    renderGalleryRecords(state: GalleryPanelState): void;
    useSelectedRecord(state: GalleryPanelState): Promise<void>;
    toggleCurrentInputs(state: GalleryPanelState): Promise<void>;
    deleteSelectedRecords(state: GalleryPanelState, records: GalleryRecordSummary[]): Promise<void>;
    moveSelectedRecords(state: GalleryPanelState, records: GalleryRecordSummary[], collectionId: string): Promise<void>;
    deleteCollection(state: GalleryPanelState, collection: GalleryCollection): Promise<void>;
    showCurrentState(state: GalleryPanelState, preview: Record<string, any>): void;
    loadRecords(state: GalleryPanelState): Promise<boolean>;
    createCollection(state: GalleryPanelState, name: string): Promise<void>;
    saveCurrent(state: GalleryPanelState, name: string): Promise<void>;
    setWidget(node: any, name: string, value: unknown): void;
    updateCollectionActions(state: GalleryPanelState): void;
}
