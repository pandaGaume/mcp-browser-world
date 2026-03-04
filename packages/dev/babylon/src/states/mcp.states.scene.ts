import { ICartesian3 } from "./mcp.states.math";
import { IColor3 } from "./mcp.states.light";

export type VisibleObjectIncludeField = "transform" | "bounds" | "material" | "color" | "visibility" | "tags";

export type VisibleObjectSortBy = "distance" | "screenCoverage" | "name";

export type MeshShapeHint = "box" | "sphere" | "plane" | "cylinder" | "torus" | "unknown";

export type MaterialType = "standard" | "pbr" | "node" | "other";

// -------------------------------------------------------------------------
// scene_visible_objects
// -------------------------------------------------------------------------

export interface IVisibleObjectMaterialState {
    name?: string;
    type: MaterialType;
    /** Dominant color (diffuse / albedo). Present when the material exposes a flat color. */
    baseColor?: IColor3;
    /** True when the material has a diffuse / albedo texture (color may be tinted by it). */
    hasTexture?: boolean;
}

export interface IVisibleObjectBoundsState {
    /** World-space bounding box corners (right-handed y-up). */
    worldMin: ICartesian3;
    worldMax: ICartesian3;
    /** Normalized screen-space bounding box (0..1 from top-left). */
    screenX?: number;
    screenY?: number;
    screenW?: number;
    screenH?: number;
    /** Fraction of screen area covered: screenW × screenH. */
    screenCoverage?: number;
}

export interface IVisibleObjectVisibilityState {
    isEnabled: boolean;
    isVisible: boolean;
    isInFrustum: boolean;
    /** Per-mesh alpha (0 = fully transparent, 1 = fully opaque). */
    visibility?: number;
}

export interface IVisibleObjectFlagsState {
    pickable: boolean;
    castsShadows: boolean;
    receivesShadows: boolean;
}

export interface IVisibleObjectState {
    id: string;
    name: string;
    type: "mesh" | "instancedMesh";
    /** Best-effort shape classification based on metadata or name. */
    shapeHint?: MeshShapeHint;
    /** World-space bounding sphere center (right-handed y-up). Present when "transform" is in include. */
    position?: ICartesian3;
    /** Distance from camera position to mesh bounding sphere center. Always present. */
    distance: number;
    /** Present when "bounds" is in include. */
    bounds?: IVisibleObjectBoundsState;
    /** Present when "material" or "color" is in include. */
    material?: IVisibleObjectMaterialState;
    /** Present when "visibility" is in include. */
    visibility?: IVisibleObjectVisibilityState;
    /** Present when "visibility" is in include. */
    flags?: IVisibleObjectFlagsState;
    /** Babylon.js tags assigned to the mesh. Present when "tags" is in include. */
    tags?: string[];
}

export interface ISceneVisibleObjectsCameraInfo {
    name: string;
    /** Camera world position (right-handed y-up). */
    position: ICartesian3;
    /** Unit forward vector (right-handed y-up). */
    forward: ICartesian3;
    /** Vertical FOV in radians. Present for perspective cameras only. */
    fov?: number;
}

export interface ISceneVisibleObjectsStats {
    /** Number of visible objects returned after all filters. */
    count: number;
    /** Number of scene meshes that were examined but excluded by filters. */
    filteredOut: number;
}

export interface ISceneVisibleObjectsState {
    camera: ISceneVisibleObjectsCameraInfo;
    visible: IVisibleObjectState[];
    stats: ISceneVisibleObjectsStats;
}

// -------------------------------------------------------------------------
// scene_pick_from_center
// -------------------------------------------------------------------------

/** Single intersection along a pick ray. Used both as the primary hit and inside the hits array. */
export interface IScenePickHit {
    meshId: string;
    meshName: string;
    /** World-space pick point (right-handed y-up). */
    pickedPoint?: ICartesian3;
    /** Distance from the camera to this intersection along the ray. */
    distance: number;
    /** World-space face normal at the pick point (right-handed y-up). */
    normal?: ICartesian3;
    /** Index of the picked triangular face. */
    faceId?: number;
}

export interface IScenePickResult {
    /** True if at least one mesh was hit. */
    hit: boolean;
    /** Closest hit mesh id. Present when hit is true. */
    meshId?: string;
    /** Closest hit mesh name. Present when hit is true. */
    meshName?: string;
    /** World-space pick point of the closest hit (right-handed y-up). */
    pickedPoint?: ICartesian3;
    /** Distance from the camera to the closest hit. */
    distance?: number;
    /** World-space face normal of the closest hit (right-handed y-up). */
    normal?: ICartesian3;
    /** Index of the picked triangular face of the closest hit. */
    faceId?: number;
    /**
     * All intersections along the ray sorted by distance (closest first).
     * Present only when the allHits option is true.
     * When hits is present, the top-level hit fields (meshId, pickedPoint, etc.)
     * are omitted — use hits[0] for the closest entry.
     */
    hits?: IScenePickHit[];
}
