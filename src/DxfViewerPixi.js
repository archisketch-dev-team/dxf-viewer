import * as three from "three";
import * as pixi from "pixi.js";
import { BatchingKey } from "./BatchingKey.js";
import { DxfWorker } from "./DxfWorker.js";
import { ColorCode, DxfScene } from "./DxfScene.js";
import { RBTree } from "./RBTree.js";

/** Level in "message" events. */
const MessageLevel = Object.freeze({
    INFO: "info",
    WARN: "warn",
    ERROR: "error",
});

/** The representation class for the viewer, based on Three.js WebGL renderer. */
export class DxfViewerPixi {
    /**
     * @param domContainer Container element to create the canvas in. Usually empty div. Should not
     *  have padding if auto-resize feature is used.
     * @param options Some options can be overridden if specified. See DxfViewerPixi.DefaultOptions.
     */
    constructor() {
        this.scene = new pixi.Container();

        /* Prevent bounding spheres calculations which fails due to non-conventional geometry
         * buffers layout. Also do not waste CPU on sorting which we do not need anyway.
         */
        // renderer.sortObjects = false;

        /* Indexed by MaterialKey, value is {key, material}. */
        this.materials = new RBTree((m1, m2) => m1.key.Compare(m2.key));
        /* Indexed by layer name, value is Layer instance. */
        this.layers = new Map();
        /* Default layer used when no layer specified. */
        this.defaultLayer = null;
        /* Indexed by block name, value is Block instance. */
        this.blocks = new Map();

        /** Set during data loading. */
        this.worker = null;

        this.colorCorrection = true;
        this.clearColor = 0xffffff;
        this.blackWhiteInversion = true;

        // 비인스턴스드 셰이더 생성
        const fragmentShader = `
            uniform vec3 uColor;
            
            void main() {
                gl_FragColor = vec4(uColor, 1.0);
            }
        `
        this.shader = {
            standard: pixi.Program.from(
                // vertex shader
                `
                    attribute vec2 position;
                    uniform mat3 translationMatrix;
                    uniform mat3 projectionMatrix;
                    
                    void main() {
                        vec2 pos = vec2(position);
                        mat3 mvp = projectionMatrix * translationMatrix;
                        gl_Position = vec4((mvp * vec3(vec2(pos.x, -pos.y), 1.0)).xy, 0.0, 1.0);
                        gl_PointSize = 2.0;
                    }
                `,
                fragmentShader
            ),
            // 인스턴스드 셰이더 생성
            instanced: pixi.Program.from(
                // vertex shader
                `
                    attribute vec2 position;
                    attribute vec3 positionOffset0;
                    attribute vec3 positionOffset1;
    
                    uniform mat3 translationMatrix;
                    uniform mat3 projectionMatrix;
                    
                    void main() {
                        vec2 pos = vec2(position);
                        pos.xy = mat2(positionOffset0[0], positionOffset1[0], positionOffset0[1], positionOffset1[1]) * pos.xy + vec2(positionOffset0[2], positionOffset1[2]);
                        mat3 mvp = projectionMatrix * translationMatrix;
                        gl_Position = vec4((mvp * vec3(vec2(pos.x, -pos.y), 1.0)).xy, 0.0, 1.0);
                        gl_PointSize = 2.0;
                    }
                `,
                fragmentShader
            )
        };

        this.snapContext = {
            points: [],
            lines: [],
        }
    }

    /**
     * @returns {boolean} True if renderer exists. May be false in case when WebGL context is lost
     * (e.g. after wake up from sleep). In such case page should be reloaded.
     */
    HasRenderer() {
        return true;
    }

    GetDxf() {
        return this.parsedDxf;
    }

    /** Load DXF into the viewer. Old content is discarded, state is reset.
     * @param {string} url DXF file URL.
     * @param {?string[]} fonts List of font URLs. Files should have typeface.js format. Fonts are
     *  used in the specified order, each one is checked until necessary glyph is found. Text is not
     *  rendered if fonts are not specified.
     * @param {?Function} progressCbk (phase, processedSize, totalSize)
     *  Possible phase values:
     *  * "font"
     *  * "fetch"
     *  * "parse"
     *  * "prepare"
     * @param {?Function} workerFactory Factory for worker creation. The worker script should
     *  invoke DxfViewerPixi.SetupWorker() function.
     */
    async Load({
        url,
        fonts = null,
        progressCbk = null,
        workerFactory = null,
    }) {
        if (url === null || url === undefined) {
            throw new Error("`url` parameter is not specified");
        }

        this._EnsureRenderer();
        // this.Clear();

        this.worker = new DxfWorker(workerFactory ? workerFactory() : null);
        const { scene, dxf } = await this.worker.Load(
            url,
            fonts,
            { fileEncoding: 'utf-8' },
            progressCbk
        );
        await this.worker.Destroy();
        this.worker = null;
        this.parsedDxf = dxf;

        this.origin = scene.origin;
        this.bounds = scene.bounds;
        this.hasMissingChars = scene.hasMissingChars;

        for (const layer of scene.layers) {
            this.layers.set(
                layer.name,
                new Layer(layer.name, layer.displayName, layer.color)
            );
        }
        this.defaultLayer = this.layers.get("0") ?? new Layer("0", "0", 0);

        /* Load all blocks on the first pass. */
        for (const batch of scene.batches) {
            if (
                batch.key.blockName !== null &&
                batch.key.geometryType !==
                    BatchingKey.GeometryType.BLOCK_INSTANCE &&
                batch.key.geometryType !==
                    BatchingKey.GeometryType.POINT_INSTANCE
            ) {
                let block = this.blocks.get(batch.key.blockName);
                if (!block) {
                    block = new Block();
                    this.blocks.set(batch.key.blockName, block);
                }
                block.PushBatch(new Batch(this, scene, batch));
            }
        }

        console.log(`DXF scene:
                     ${scene.batches.length} batches,
                     ${this.layers.size} layers,
                     ${this.blocks.size} blocks,
                     vertices ${scene.vertices.byteLength} B,
                     indices ${scene.indices.byteLength} B
                     transforms ${scene.transforms.byteLength} B`);

        /* Instantiate all entities. */
        for (const batch of scene.batches) {
            this._LoadBatch(scene, batch);
        }
    }

    Render() {
        this._EnsureRenderer();
    }

    /** @return {Iterable<{name:String, color:number}>} List of layer names. */
    GetLayers(nonEmptyOnly = false) {
        const result = [];
        for (const lyr of this.layers.values()) {
            if (nonEmptyOnly && lyr.objects.length == 0) {
                continue;
            }
            result.push({
                name: lyr.name,
                displayName: lyr.displayName,
                color: this._TransformColor(lyr.color),
            });
        }
        return result;
    }

    ShowLayer(name, show) {
        this._EnsureRenderer();
        const layer = this.layers.get(name);
        if (!layer) {
            return;
        }
        for (const obj of layer.objects) {
            obj.visible = show;
        }
        this.Render();
    }

    /** Reset the viewer state. */
    Clear() {
        this._EnsureRenderer();
        if (this.worker) {
            this.worker.Destroy(true);
            this.worker = null;
        }
        this.scene.children = []; // pixi counterpart
        for (const layer of this.layers.values()) {
            layer.Dispose();
        }
        this.layers.clear();
        this.blocks.clear();
        this.materials.each((e) => e.material.dispose());
        this.materials.clear();
    }

    /** Free all resources. The viewer object should not be used after this method was called. */
    Destroy() {
        if (!this.HasRenderer()) {
            return;
        }
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
        }
        this.Clear();
        this._Emit("destroyed");
        for (const m of this.simplePointMaterial) {
            m.dispose();
        }
        for (const m of this.simpleColorMaterial) {
            m.dispose();
        }
        this.simplePointMaterial = null;
        this.simpleColorMaterial = null;
    }

    GetScene() {
        return this.scene;
    }

    /** @return {Vector2} Scene origin in global drawing coordinates. */
    GetOrigin() {
        return this.origin;
    }

    /**
     * @return {?{maxX: number, maxY: number, minX: number, minY: number}} Scene bounds in model
     *      space coordinates. Null if empty scene.
     */
    GetBounds() {
        return this.bounds;
    }

    /** Subscribe to the specified event. The following events are defined:
     *  * "loaded" - new scene loaded.
     *  * "cleared" - current scene cleared.
     *  * "destroyed" - viewer instance destroyed.
     *  * "resized" - viewport size changed. Details: {width, height}
     *  * "pointerdown" - Details: {domEvent, position:{x,y}}, position is in scene coordinates.
     *  * "pointerup"
     *  * "viewChanged"
     *  * "message" - Some message from the viewer. {message: string, level: string}.
     *
     * @param eventName {string}
     * @param eventHandler {function} Accepts event object.
     */
    Subscribe(eventName, eventHandler) {
        this._EnsureRenderer();
        this.canvas.addEventListener(
            EVENT_NAME_PREFIX + eventName,
            eventHandler
        );
    }

    /** Unsubscribe from previously subscribed event. The arguments should match previous
     * Subscribe() call.
     *
     * @param eventName {string}
     * @param eventHandler {function}
     */
    Unsubscribe(eventName, eventHandler) {
        this._EnsureRenderer();
        this.canvas.removeEventListener(
            EVENT_NAME_PREFIX + eventName,
            eventHandler
        );
    }

    // /////////////////////////////////////////////////////////////////////////////////////////////

    _EnsureRenderer() {
        if (!this.HasRenderer()) {
            throw new Error(
                "WebGL renderer not available. " +
                    "Probable WebGL context loss, try refreshing the page."
            );
        }
    }

    _Emit(eventName, data = null) {
        this.canvas.dispatchEvent(
            new CustomEvent(EVENT_NAME_PREFIX + eventName, { detail: data })
        );
    }

    _Message(message, level = MessageLevel.INFO) {
        this._Emit("message", { message, level });
    }

    _OnResize(entry) {
        this.SetSize(
            Math.floor(entry.contentRect.width),
            Math.floor(entry.contentRect.height)
        );
    }

    _LoadBatch(scene, batch) {
        if (
            batch.key.layerName === 'Defpoints' ||
            (batch.key.blockName !== null &&
            batch.key.geometryType !==
                BatchingKey.GeometryType.BLOCK_INSTANCE &&
            batch.key.geometryType !== BatchingKey.GeometryType.POINT_INSTANCE)
        ) {
            /* Block definition. */
            return;
        }
        const objects = new Batch(this, scene, batch).CreateObjects();
        for (const obj of objects) {
            this.scene.addChild(obj);
            const layer = obj._dxfViewerLayer ?? this.defaultLayer;
            layer.PushObject(obj);
        }
    }

    /** Ensure the color is contrast enough with current background color.
     * @param color {number} RGB value.
     * @return {number} RGB value to use for rendering.
     */
    _TransformColor(color) {
        if (
            !this.colorCorrection &&
            !this.blackWhiteInversion
        ) {
            return color;
        }
        /* Just black and white inversion. */
        const bkgLum = Luminance(this.clearColor);
        if (color === 0xffffff && bkgLum >= 0.8) {
            return 0;
        }
        if (color === 0 && bkgLum <= 0.2) {
            return 0xffffff;
        }
        if (!this.colorCorrection) {
            return color;
        }
        const fgLum = Luminance(color);
        const MIN_TARGET_RATIO = 1.5;
        const contrast = ContrastRatio(color, this.clearColor);
        const diff = contrast >= 1 ? contrast : 1 / contrast;
        if (diff < MIN_TARGET_RATIO) {
            let targetLum;
            if (bkgLum > 0.5) {
                targetLum = bkgLum / 2;
            } else {
                targetLum = bkgLum * 2;
            }
            if (targetLum > fgLum) {
                color = Lighten(color, targetLum / fgLum);
            } else {
                color = Darken(color, fgLum / targetLum);
            }
        }
        return color;
    }
}

DxfViewerPixi.MessageLevel = MessageLevel;

DxfViewerPixi.DefaultOptions = {
    canvasWidth: 400,
    canvasHeight: 300,
    /** Automatically resize canvas when the container is resized. This options utilizes
     *  ResizeObserver API which is still not fully standardized. The specified canvas size is
     *  ignored if the option is enabled.
     */
    autoResize: false,
    /** Frame buffer clear color. */
    clearColor: 0xffffff,
    /** Frame buffer clear color alpha value. */
    clearAlpha: 1.0,
    /** Use alpha channel in a framebuffer. */
    canvasAlpha: false,
    /** Assume premultiplied alpha in a framebuffer. */
    canvasPremultipliedAlpha: true,
    /** Use antialiasing. May degrade performance on poor hardware. */
    antialias: true,
    /** Correct entities colors to ensure that they are always visible with the current background
     * color.
     */
    colorCorrection: false,
    /** Simpler version of colorCorrection - just invert pure white or black entities if they are
     * invisible on current background color.
     */
    blackWhiteInversion: true,
    /** Size in pixels for rasterized points (dot mark). */
    pointSize: 2,
    /** Scene generation options. */
    sceneOptions: DxfScene.DefaultOptions,
    /** Retain the simple object representing the parsed DXF - will consume a lot of additional
     * memory.
     */
    retainParsedDxf: false,
    /** Whether to preserve the buffers until manually cleared or overwritten. */
    preserveDrawingBuffer: false,
    /** Encoding to use for decoding DXF file text content. DXF files newer than DXF R2004 (AC1018)
     * use UTF-8 encoding. Older files use some code page which is specified in $DWGCODEPAGE header
     * variable. Currently parser is implemented in such a way that encoding must be specified
     * before the content is parsed so there is no chance to use this variable dynamically. This may
     * be a subject for future changes. The specified value should be suitable for passing as
     * `TextDecoder` constructor `label` parameter.
     */
    fileEncoding: "utf-8",
};

DxfViewerPixi.SetupWorker = function () {
    new DxfWorker(self, true);
};

const InstanceType = Object.freeze({
    /** Not instanced. */
    NONE: 0,
    /** Full affine transform per instance. */
    FULL: 1,
    /** Point instances, 2D-translation vector per instance. */
    POINT: 2,

    /** Number of types. */
    MAX: 3,
});

class Batch {
    /**
     * @param {DxfViewerPixi} viewer
     * @param scene Serialized scene.
     * @param batch Serialized scene batch.
     */
    constructor(viewer, scene, batch) {
        this.viewer = viewer;
        this.key = batch.key;

        if (batch.hasOwnProperty("verticesOffset")) {
            const verticesArray = new Float32Array(
                scene.vertices,
                batch.verticesOffset * Float32Array.BYTES_PER_ELEMENT,
                batch.verticesSize
            );
            if (
                this.key.geometryType !==
                    BatchingKey.GeometryType.POINT_INSTANCE ||
                scene.pointShapeHasDot
            ) {
                this.vertices = new three.BufferAttribute(verticesArray, 2);
            }
            if (
                this.key.geometryType ===
                BatchingKey.GeometryType.POINT_INSTANCE
            ) {
                this.transforms = new three.InstancedBufferAttribute(
                    verticesArray,
                    2
                );
            }
        }

        if (batch.hasOwnProperty("chunks")) {
            this.chunks = [];
            for (const rawChunk of batch.chunks) {
                const verticesArray = new Float32Array(
                    scene.vertices,
                    rawChunk.verticesOffset * Float32Array.BYTES_PER_ELEMENT,
                    rawChunk.verticesSize
                );
                const indicesArray = new Uint16Array(
                    scene.indices,
                    rawChunk.indicesOffset * Uint16Array.BYTES_PER_ELEMENT,
                    rawChunk.indicesSize
                );
                this.chunks.push({
                    vertices: new three.BufferAttribute(verticesArray, 2),
                    indices: new three.BufferAttribute(indicesArray, 1),
                });
            }
        }

        if (batch.hasOwnProperty("transformsOffset")) {
            const transformsArray = new Float32Array(
                scene.transforms,
                batch.transformsOffset * Float32Array.BYTES_PER_ELEMENT,
                batch.transformsSize
            );
            /* Each transform is 3x2 matrix which is split into two 3D vectors which will occupy two
             * attribute slots.
             */
            const buf = new three.InstancedInterleavedBuffer(
                transformsArray,
                6
            );
            this.transforms0 = new three.InterleavedBufferAttribute(buf, 3, 0);
            this.transforms1 = new three.InterleavedBufferAttribute(buf, 3, 3);
        }

        this.layer =
            this.key.layerName !== null
                ? this.viewer.layers.get(this.key.layerName)
                : null;
    }

    GetInstanceType() {
        switch (this.key.geometryType) {
            case BatchingKey.GeometryType.BLOCK_INSTANCE:
                return InstanceType.FULL;
            case BatchingKey.GeometryType.POINT_INSTANCE:
                return InstanceType.POINT;
            default:
                return InstanceType.NONE;
        }
    }

    /** Create scene objects corresponding to batch data.
     * @param {?Batch} instanceBatch Batch with instance transform. Null for non-instanced object.
     */
    *CreateObjects(instanceBatch = null) {
        if (
            this.key.geometryType === BatchingKey.GeometryType.BLOCK_INSTANCE ||
            this.key.geometryType === BatchingKey.GeometryType.POINT_INSTANCE
        ) {
            if (instanceBatch !== null) {
                throw new Error(
                    "Unexpected instance batch specified for instance batch"
                );
            }
            yield* this._CreateBlockInstanceObjects();
            return;
        }
        yield* this._CreateObjects(instanceBatch);
    }

    _AddSnapPoints(vertices, instanceBatch) {
        if (instanceBatch) {
            // 인스턴싱된 각 라인의 실제 좌표를 계산하여 저장
            const transforms0 = instanceBatch.transforms0.data.array;
            const transforms1 = instanceBatch.transforms1.data.array;

            // 각 인스턴스에 대해 반복
            for (let t = 0; t < instanceBatch.transforms0.data.count; t += 1) {
                const startIndex = t * instanceBatch.transforms0.data.stride;
                // x
                const m00 = transforms0[startIndex];
                const m10 = transforms0[startIndex + 1];
                const tx = transforms0[startIndex + 2];
                // y
                const m01 = transforms1[startIndex + 3];
                const m11 = transforms1[startIndex + 4];
                const ty = transforms1[startIndex + 5];
                
                const stride = vertices.itemSize;
                for (let i = 0; i < vertices.array.length; i += stride) {
                    const x1 = vertices.array[i];
                    const y1 = vertices.array[i + 1];
                    
                    this.viewer.snapContext.points.push({
                        x: m00 * x1 + m10 * y1 + tx,
                        y: -(m01 * x1 + m11 * y1 + ty)
                    });
                }
            }
        } else {
            /**
             * Stride for a point is 2.
             * `array = [p1.x, p1.y, p2.x, p2.y, ...];`
             */
            const stride = vertices.itemSize;
            for (let i = 0; i < vertices.array.length; i += stride) {
                this.viewer.snapContext.points.push({
                    x: vertices.array[i],
                    y: -vertices.array[i + 1],
                })
            }
        }
    }

    _AddSnapLines(vertices, chunks, instanceBatch) {
        if (chunks) {
            chunks.forEach(chunk => {
                if (instanceBatch) {
                    // 인스턴싱된 각 라인의 실제 좌표를 계산하여 저장
                    const transforms0 = instanceBatch.transforms0.data.array;
                    const transforms1 = instanceBatch.transforms1.data.array;

                    for (let t = 0; t < instanceBatch.transforms0.data.count; t += 1) {
                        const startIndex = t * instanceBatch.transforms0.data.stride;
                        // x
                        const m00 = transforms0[startIndex];
                        const m10 = transforms0[startIndex + 1];
                        const tx = transforms0[startIndex + 2];
                        // y
                        const m01 = transforms1[startIndex + 3];
                        const m11 = transforms1[startIndex + 4];
                        const ty = transforms1[startIndex + 5];

                        if (chunk.indices) {
                            const stride = chunk.indices.itemSize * 2;
                            for (let i = 0; i < chunk.indices.array.length; i += stride) {
                                const x1 = chunk.vertices.array[chunk.indices.array[i] * stride];
                                const y1 = chunk.vertices.array[chunk.indices.array[i] * stride + 1];
                                const x2 = chunk.vertices.array[chunk.indices.array[i + 1] * stride];
                                const y2 = chunk.vertices.array[chunk.indices.array[i + 1] * stride + 1];
            
                                // 변환 행렬 적용하여 실제 좌표 계산
                                const transformedStart = {
                                    x: m00 * x1 + m10 * y1 + tx,
                                    y: -(m01 * x1 + m11 * y1 + ty)
                                };
                                
                                const transformedEnd = {
                                    x: m00 * x2 + m10 * y2 + tx,
                                    y: -(m01 * x2 + m11 * y2 + ty)
                                };
                                
                                this.viewer.snapContext.lines.push({
                                    start: transformedStart,
                                    end: transformedEnd
                                });
                            }
                        } else {
                            const stride = chunk.vertices.itemSize * 2;
                            for (let i = 0; i < chunk.vertices.array.length; i += stride) {
                                // 원래 좌표 추출
                                const x1 = chunk.vertices.array[i];
                                const y1 = chunk.vertices.array[i + 1];
                                const x2 = chunk.vertices.array[i + 2];
                                const y2 = chunk.vertices.array[i + 3];

                                // 변환 행렬 적용하여 실제 좌표 계산
                                const transformedStart = {
                                    x: m00 * x1 + m10 * y1 + tx,
                                    y: -(m01 * x1 + m11 * y1 + ty)
                                };
                                
                                const transformedEnd = {
                                    x: m00 * x2 + m10 * y2 + tx,
                                    y: -(m01 * x2 + m11 * y2 + ty)
                                };
                                
                                this.viewer.snapContext.lines.push({
                                    start: transformedStart,
                                    end: transformedEnd
                                });
                            }
                        }
                    }
                } else {
                    if (chunk.indices) {
                        const step = 2;
                        const stride = chunk.indices.itemSize * step;
                        for (let i = 0; i < chunk.indices.array.length; i += stride) {
                            const start = {
                                x: chunk.vertices.array[chunk.indices.array[i] * stride],
                                y: -chunk.vertices.array[chunk.indices.array[i] * stride + 1],
                            }
                            const end = {
                                x: chunk.vertices.array[chunk.indices.array[i + 1] * stride],
                                y: -chunk.vertices.array[chunk.indices.array[i + 1] * stride + 1],
                            }
        
                            this.viewer.snapContext.lines.push({ start, end });
                        }
                    } else {
                        const stride = chunk.vertices.itemSize * 2;
                        for (let i = 0; i < chunk.vertices.array.length; i += stride) {
                            const start = {
                                x: chunk.vertices.array[i],
                                y: -chunk.vertices.array[i + 1],
                            }
                            const end = {
                                x: chunk.vertices.array[i + 2],
                                y: -chunk.vertices.array[i + 3],
                            }
        
                            this.viewer.snapContext.lines.push({ start, end });
                        }
                    }
                }
            });
        }

        if (vertices) {
            if (instanceBatch) {
                // 인스턴싱된 각 라인의 실제 좌표를 계산하여 저장
                // transforms0와 transforms1 데이터는 동일. transforms0는 x좌표, transforms1는 y좌표를 참조
                const transforms0 = instanceBatch.transforms0.data.array;
                const transforms1 = instanceBatch.transforms1.data.array;

                // 각 인스턴스에 대해 반복
                for (let t = 0; t < instanceBatch.transforms0.data.count; t += 1) {
                    const startIndex = t * instanceBatch.transforms0.data.stride;
                    // x
                    const m00 = transforms0[startIndex];
                    const m10 = transforms0[startIndex + 1];
                    const tx = transforms0[startIndex + 2];
                    // y
                    const m01 = transforms1[startIndex + 3];
                    const m11 = transforms1[startIndex + 4];
                    const ty = transforms1[startIndex + 5];
                    
                    // 각 라인 세그먼트에 대해 반복
                    const stride = vertices.itemSize * 2;
                    for (let i = 0; i < vertices.array.length; i += stride) {
                        // 원래 좌표 추출
                        const x1 = vertices.array[i];
                        const y1 = vertices.array[i + 1];
                        const x2 = vertices.array[i + 2];
                        const y2 = vertices.array[i + 3];
                        
                        // 변환 행렬 적용하여 실제 좌표 계산
                        const transformedStart = {
                            x: m00 * x1 + m10 * y1 + tx,
                            y: -(m01 * x1 + m11 * y1 + ty)
                        };
                        
                        const transformedEnd = {
                            x: m00 * x2 + m10 * y2 + tx,
                            y: -(m01 * x2 + m11 * y2 + ty)
                        };
                        
                        this.viewer.snapContext.lines.push({
                            start: transformedStart,
                            end: transformedEnd
                        });
                    }
                }
            } else {
                /**
                 * array = [line1.start.x, line1.start.y, line1.end.x, line1.end.y, line2.start.x, line2.start.y, line2.end.x, line2.end.y];
                 */
                const stride = vertices.itemSize * 2;
                for (let i = 0; i < vertices.array.length; i += stride) {
                    const start = {
                        x: vertices.array[i],
                        y: -vertices.array[i + 1],
                    }
                    const end = {
                        x: vertices.array[i + 2],
                        y: -vertices.array[i + 3],
                    }

                    this.viewer.snapContext.lines.push({ start, end });
                }
            }
        }
    }

    *_CreateObjects(instanceBatch) {
        const color = instanceBatch
            ? instanceBatch._GetInstanceColor(this)
            : this.key.color;

            const transformedColor = this.viewer._TransformColor(color);

            const r = (((transformedColor >> 16) & 0xff) / 255).toFixed(6);
            const g = (((transformedColor >> 8) & 0xff) / 255).toFixed(6);
            const b = ((transformedColor & 0xff) / 255).toFixed(6);

        let draw_mode;
        switch (this.key.geometryType) {
            case BatchingKey.GeometryType.POINTS:
            case BatchingKey.GeometryType.POINT_INSTANCE:
                draw_mode = pixi.DRAW_MODES.POINTS;

                // POINT에 instanceBatch가 있는 경우는 없었음.
                this._AddSnapPoints(this.vertices, instanceBatch);
                break;
            case BatchingKey.GeometryType.LINES:
            case BatchingKey.GeometryType.INDEXED_LINES:
                draw_mode = pixi.DRAW_MODES.LINES;

                this._AddSnapLines(this.vertices, this.chunks, instanceBatch);
                break;
            case BatchingKey.GeometryType.TRIANGLES:
            case BatchingKey.GeometryType.INDEXED_TRIANGLES:
                draw_mode = pixi.DRAW_MODES.TRIANGLES;

                if (this.chunks) {
                    this.chunks.forEach(chunk => {
                        // point 스냅이기 때문에 `chunk.indices`는 사용하지 않음
                        this._AddSnapPoints(chunk.vertices, instanceBatch);
                    })
                }
                break;
            default:
                break;
        }

        const shaderProgram = instanceBatch ? this.viewer.shader.instanced : this.viewer.shader.standard;
        const shader = new pixi.Shader(shaderProgram, {
            uColor: [r, g, b]
        });

        function CreateObject(vertices, indices) {
            if (draw_mode == null) {
                const empty = new pixi.Sprite(pixi.Texture.EMPTY);
                return empty;
            }
            const geometry = new pixi.Geometry();
            geometry.addAttribute(
                "position",
                vertices.array,
                2,
                false,
                pixi.TYPES.FLOAT
            );
            if (indices) {
                geometry.addIndex(indices.array);
            }
            if (instanceBatch) {
                geometry.instanceCount = instanceBatch.transforms0.data.count;
                const offsetBuffer = new pixi.Buffer(
                    instanceBatch.transforms0.data.array
                );

                geometry.addAttribute(
                    "positionOffset0",
                    offsetBuffer,
                    3,
                    false,
                    pixi.TYPES.FLOAT,
                    6 * Float32Array.BYTES_PER_ELEMENT,
                    0,
                    true
                );
                geometry.addAttribute(
                    "positionOffset1",
                    offsetBuffer,
                    3,
                    false,
                    pixi.TYPES.FLOAT,
                    6 * Float32Array.BYTES_PER_ELEMENT,
                    3 * Float32Array.BYTES_PER_ELEMENT,
                    true
                );
            }

            return new pixi.Mesh(geometry, shader, null, draw_mode);
        }

        if (this.chunks) {
            for (const chunk of this.chunks) {
                yield CreateObject(chunk.vertices, chunk.indices);
            }
        } else {
            yield CreateObject(this.vertices);
        }
    }

    *_CreateBlockInstanceObjects() {
        const block = this.viewer.blocks.get(this.key.blockName);
        if (!block) {
            return;
        }
        for (const batch of block.batches) {
            yield* batch.CreateObjects(this);
        }
        if (this.vertices) {
            /* Dots for point shapes. */
            yield* this._CreateObjects();
        }
    }

    /**
     * @param {Batch} blockBatch Block definition batch.
     * @return {number} RGB color value for a block instance.
     */
    _GetInstanceColor(blockBatch) {
        const defColor = blockBatch.key.color;
        if (defColor === ColorCode.BY_BLOCK) {
            return this.key.color;
        } else if (defColor === ColorCode.BY_LAYER) {
            if (blockBatch.layer) {
                return blockBatch.layer.color;
            }
            return this.layer ? this.layer.color : 0;
        }
        return defColor;
    }
}

class Layer {
    constructor(name, displayName, color) {
        this.name = name;
        this.displayName = displayName;
        this.color = color;
        this.objects = [];
    }

    PushObject(obj) {
        this.objects.push(obj);
    }

    Dispose() {
        for (const obj of this.objects) {
            obj.geometry.dispose();
        }
        this.objects = null;
    }
}

class Block {
    constructor() {
        this.batches = [];
    }

    /** @param batch {Batch} */
    PushBatch(batch) {
        this.batches.push(batch);
    }
}

/** Custom viewer event names are prefixed with this string. */
const EVENT_NAME_PREFIX = "__dxf_";

/** Transform sRGB color component to linear color space. */
function LinearColor(c) {
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Transform linear color component to sRGB color space. */
function SRgbColor(c) {
    return c < 0.003 ? c * 12.92 : Math.pow(c, 1 / 2.4) * 1.055 - 0.055;
}

/** Get relative luminance value for a color.
 * https://www.w3.org/TR/2008/REC-WCAG20-20081211/#relativeluminancedef
 * @param color {number} RGB color value.
 * @return {number} Luminance value in range [0; 1].
 */
function Luminance(color) {
    const r = LinearColor(((color & 0xff0000) >>> 16) / 255);
    const g = LinearColor(((color & 0xff00) >>> 8) / 255);
    const b = LinearColor((color & 0xff) / 255);

    return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

/**
 * Get contrast ratio for a color pair.
 * https://www.w3.org/TR/2008/REC-WCAG20-20081211/#contrast-ratiodef
 * @param c1
 * @param c2
 * @return {number} Contrast ratio between the colors. Greater than one if the first color color is
 *  brighter than the second one.
 */
function ContrastRatio(c1, c2) {
    return (Luminance(c1) + 0.05) / (Luminance(c2) + 0.05);
}

function HlsToRgb({ h, l, s }) {
    let r, g, b;
    if (s === 0) {
        /* Achromatic */
        r = g = b = l;
    } else {
        function hue2rgb(p, q, t) {
            if (t < 0) {
                t += 1;
            }
            if (t > 1) {
                t -= 1;
            }
            if (t < 1 / 6) {
                return p + (q - p) * 6 * t;
            }
            if (t < 1 / 2) {
                return q;
            }
            if (t < 2 / 3) {
                return p + (q - p) * (2 / 3 - t) * 6;
            }
            return p;
        }

        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        r = hue2rgb(p, q, h + 1 / 3);
        g = hue2rgb(p, q, h);
        b = hue2rgb(p, q, h - 1 / 3);
    }

    return (
        (Math.min(Math.floor(SRgbColor(r) * 256), 255) << 16) |
        (Math.min(Math.floor(SRgbColor(g) * 256), 255) << 8) |
        Math.min(Math.floor(SRgbColor(b) * 256), 255)
    );
}

function RgbToHls(color) {
    const r = LinearColor(((color & 0xff0000) >>> 16) / 255);
    const g = LinearColor(((color & 0xff00) >>> 8) / 255);
    const b = LinearColor((color & 0xff) / 255);

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let h, s;
    const l = (max + min) / 2;

    if (max === min) {
        /* Achromatic */
        h = s = 0;
    } else {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r:
                h = (g - b) / d + (g < b ? 6 : 0);
                break;
            case g:
                h = (b - r) / d + 2;
                break;
            case b:
                h = (r - g) / d + 4;
                break;
        }
        h /= 6;
    }

    return { h, l, s };
}

function Lighten(color, factor) {
    const hls = RgbToHls(color);
    hls.l *= factor;
    if (hls.l > 1) {
        hls.l = 1;
    }
    return HlsToRgb(hls);
}

function Darken(color, factor) {
    const hls = RgbToHls(color);
    hls.l /= factor;
    return HlsToRgb(hls);
}
