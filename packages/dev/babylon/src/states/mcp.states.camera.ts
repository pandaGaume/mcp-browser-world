import { IBounds, ICartesian3, IQuaternion } from "./mcp.states.math";

export type ProjectionMode = "perspective" | "orthographic";

export interface IFrustumBase {
    kind: ProjectionMode;
    near?: number;
    far?: number;
}

export interface IPerspectiveFrustum extends IFrustumBase {
    kind: "perspective";
    fov: number; // vertical FOV in radians
}

export interface IOrthoFrustum extends IFrustumBase {
    kind: "orthographic";
    // Use either size (portable) or explicit bounds (engine-like)
    size?: number; // frustum height in world units
    left?: number;
    right?: number;
    top?: number;
    bottom?: number;
}

export type IFrustum = IPerspectiveFrustum | IOrthoFrustum;

export interface ICameraState {
    id?: string;
    name?: string;

    position: ICartesian3;

    rotationQuat?: IQuaternion;
    rotationEuler?: ICartesian3;

    target?: ICartesian3;
    up?: ICartesian3;

    frustum: IFrustum;

    viewport?: IBounds;

    isEnabled?: boolean;
    layerMask?: number;

    version?: number;
}
