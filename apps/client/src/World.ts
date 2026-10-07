import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { CreateGround } from '@babylonjs/core/Meshes/Builders/groundBuilder';
import { CreateTorus } from '@babylonjs/core/Meshes/Builders/torusBuilder';
import { CreatePlane } from '@babylonjs/core/Meshes/Builders/planeBuilder';
import { CreateCylinder } from '@babylonjs/core/Meshes/Builders/cylinderBuilder';
import { CreatePolyhedron } from '@babylonjs/core/Meshes/Builders/polyhedronBuilder';
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder';
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent';
import '@babylonjs/core/Culling/ray';
const MeshBuilder = { CreateBox, CreateGround, CreateTorus, CreatePlane, CreateCylinder, CreatePolyhedron, CreateSphere };
import { balance, buildings, units, legendaryExpansion, ridgeHeightAt, terrainHeightAt, terrainBuildable, resourcePlacementBounds, placementAreaDiscovered, type BuildingId, type Cell, type GameplayCommand, type PlayerView, type Rotation, type TeamPing, type TerrainRegion, type ViewEntity } from '@frontier/shared';

import { MotionTrack, PresentationClock, ProgressTrack, GateTrack } from './MotionTrack';
import { browserDeliveryDiagnostics, browserResponseProbe, observeResponseRender, type ResponseRenderEntity } from './BrowserResponseDiagnostics';
import { AssetRenderer, loadAssetBundle, type AssetInstance } from './AssetRenderer';
import { readPreferences, matchesHotkey, heldPanKey, suppressGameplayHotkeys, type Preferences } from './preferences';
import { buildingPlacementCommand, resolveBuildingPlacement } from './buildingPlacement';

export interface WorldTarget { id?: string; xMm: number; zMm: number }
export interface WorldHover { target: WorldTarget; x: number; y: number }
/** Screen-relative ground directions in Babylon's left-handed world. */
export function cameraPanDirections(alpha: number): { forward: Vector3; right: Vector3 } {
  const forward = new Vector3(-Math.cos(alpha), 0, -Math.sin(alpha));
  return { forward, right: new Vector3(forward.z, 0, -forward.x) };
}
/** Keep RTS selection/orders separate from Babylon's explicit gesture mapping. */
export function configureRtsCameraControls(camera: ArcRotateCamera): void {
  const pointer = camera.inputs.attached.pointers as unknown as { buttons: number[] };
  pointer.buttons = [1];
  camera.movement.input.inputMap = [
    { source: 'pointer', button: 1, interaction: 'rotate' },
    ...camera.movement.input.inputMap.filter(entry => entry.source !== 'pointer'),
  ];
}
interface RenderEntity { asset: AssetInstance; entity: ViewEntity; staticResource: boolean; wallMask: number; ambient?: AssetInstance; hitTick?: number; turretTick?:number; gateTick?: number; gateFrom?: number; gatePose?: number; gateHistory?:GateTrack; construction?:ProgressTrack; jobs?:Map<string,{kind:string;typeId:string;state:string;track:ProgressTrack}>; motion: MotionTrack; actionHistory?:(NonNullable<ViewEntity['visualAction']>&{presentedTick?:number})[]; moving: boolean; id: string; root: TransformNode; ring: Mesh; health: Mesh; healthFill: Mesh; wardBar?:Mesh; wardFill?:Mesh; healthEligible: boolean; from: Vector3; target: Vector3; received: number; hp: number }

/** Browser renderer for the host-verified original generated asset library. */
export class World {
  readonly ready: Promise<void>;
  assets!: AssetRenderer;
  private readonly assetAbort = new AbortController();
  private disposed = false;
  private responseSubmitted?:Map<AssetInstance,import('./AssetRenderer').AssetDrawEvidence>;
  private preferences = readPreferences();
  private receivedViewAt = 0;
  private presentationClock?: PresentationClock;
  private pointerEdge: { x: number; y: number } | null = null;
  private lastHoverAt = 0;
  private readonly pointerLeave: () => void;
  private readonly blur: () => void;
  private readonly focusIn: (event: FocusEvent) => void;
  readonly engine: Engine;
  readonly scene: Scene;
  readonly camera: ArcRotateCamera;
  private readonly preview: TransformNode;
  private readonly materials = new Map<string, StandardMaterial>();
  private readonly shadows: ShadowGenerator;
  private readonly resize: () => void;
  private readonly keys = new Set<string>();
  private readonly keyDown: (e: KeyboardEvent) => void;
  private readonly keyUp: (e: KeyboardEvent) => void;
  private readonly contextLost: (e: Event) => void;
  private readonly contextRestored: () => void;
  private view: PlayerView | null = null;
  private streamActive = true;
  private readonly rendered = new Map<string, RenderEntity>();
  private selected: string[] = [];
  private selectionIndicators?:Map<string,Mesh>;
  private ground: Mesh | null = null;
  private fogMesh: Mesh | null = null;
  private previewMesh: TransformNode | null = null;
  private terrainDetail: TransformNode | null = null;
  private terrainArt: AssetInstance[] = [];
  private groundTerrain: TerrainRegion[] = [];
  private ridgeFaces: { positions: number[]; fogCell: number }[] = [];
  private rallyMarker: TransformNode | null = null;
  private rallyBuilding: string | null = null;
  private targetMode = false;
  private wallTargetType: BuildingId | null = null;
  private wallStart: Cell | null = null;
  private wallZFirst = false;
  private wallCells: Cell[] = [];
  private wallPreview: Mesh[] = [];
  private readonly projectiles = new Map<string, { mesh: TransformNode; from: Vector3; to: Vector3; received: number; motion: MotionTrack }>();
  private readonly projectilePool: AssetInstance[] = [];
  private impactWarnings = new Map<string, Mesh>();
  private readonly effects = new Map<string, { mesh: TransformNode; asset: AssetInstance; tick: number; duration: number; death: boolean; wave?:{mesh:Mesh;radius:number} }>();
  private readonly seenEffects = new Set<string>();
  private readonly pingMeshes = new Map<string, TransformNode>();
  private visibleCells = new Set<number>();
  private fogColumns = 1;
  private placementTarget: WorldTarget | null = null;
  placementRotation: Rotation = 0;
  private lastFog = '';
  private placement: BuildingId | null = null;
  private pointerStart: { x: number; y: number; button: number } | null = null;
  private readonly pointerDown: (e: PointerEvent) => void;
  private readonly pointerUp: (e: PointerEvent) => void;
  private readonly pointerMove: (e: PointerEvent) => void;
  private readonly doubleClick: (e: MouseEvent) => void;
  private readonly contextMenu: (e: MouseEvent) => void;
  onSelection: (ids: string[]) => void = () => undefined;
  onOrder: (target: WorldTarget, queued: boolean) => void = () => undefined;
  onHover: (hover: WorldHover | null) => string = () => 'default';
  onBuild: (target: WorldTarget, queued: boolean) => void = () => undefined;
  onWall: (cells: Cell[], queued: boolean) => void = () => undefined;
  onTarget: (target: WorldTarget, queued: boolean) => void = () => undefined;
  onRally: (buildingId: string, target: WorldTarget) => void = () => undefined;
  onPlacementHint: (text: string) => void = () => undefined;
  onDrag: (rect: { x: number; y: number; width: number; height: number } | null) => void = () => undefined;

  constructor(readonly canvas: HTMLCanvasElement, onStatus: (message: string | null) => void) {
    if (!canvas.getContext('webgl2', { antialias: true })) throw new Error('WebGL2 is unavailable. Enable browser hardware acceleration and use a desktop browser with WebGL2 support.');
    this.engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
    this.engine.setHardwareScalingLevel(Math.max(1, window.devicePixelRatio / 1.5));
    this.scene = new Scene(this.engine);
    this.scene.onAfterRenderObservable.add(()=>{if(this.view&&this.streamActive&&document.visibilityState==='visible')browserDeliveryDiagnostics.rendered(this.view);});
    this.scene.clearColor = new Color4(0.12, 0.19, 0.19, 1);
    this.scene.ambientColor = new Color3(0.12, 0.15, 0.1);
    this.camera = new ArcRotateCamera('rts-camera', -Math.PI / 2.6, 0.82, 47, new Vector3(27, 0, 29), this.scene);
    this.camera.lowerBetaLimit = 0.3;
    this.camera.minZ = 1;
    this.camera.maxZ = 2000;
    this.camera.upperBetaLimit = 1.25;
    this.camera.lowerRadiusLimit = 12;
    this.camera.upperRadiusLimit = 90;
    this.camera.wheelPrecision = 18;
    this.camera.panningSensibility = 0;
    this.camera.attachControl(canvas, true);
    this.camera.inputs.removeByType('ArcRotateCameraKeyboardMoveInput');
    configureRtsCameraControls(this.camera);
    const sky = new HemisphericLight('sky', new Vector3(0, 1, 0), this.scene);
    sky.intensity = 0.65;
    sky.groundColor = new Color3(0.32, 0.3, 0.23);
    const sun = new DirectionalLight('sun', new Vector3(-0.6, -1.4, 0.65), this.scene);
    sun.position = new Vector3(40, 60, -30);
    sun.intensity = 0.85;
    this.shadows = new ShadowGenerator(1024, sun);
    this.shadows.useBlurExponentialShadowMap = true;
    this.shadows.blurKernel = 16;
    this.preview = new TransformNode('frontier-preview', this.scene);
    const ground = MeshBuilder.CreateGround('preview-terrain', { width: 100, height: 100, subdivisions: 32 }, this.scene);
    ground.position.set(32, -0.03, 32);
    ground.material = this.material('grass', '#8b9470');
    ground.receiveShadows = true;
    ground.parent = this.preview;
    this.ready = loadAssetBundle(this.assetAbort.signal).then(bundle => {
      if (this.disposed) return;
      this.assets = new AssetRenderer(this.scene, bundle, this.shadows);
      this.setPreferences(this.preferences);
      this.makeBuilding('town_center', 29, 31, '#8ac6bd', this.preview);
      this.makeBuilding('house', 19, 25, '#8ac6bd', this.preview);
      this.makeBuilding('barracks', 21, 42, '#8ac6bd', this.preview);
      for (let i = 0; i < 34; i++) {
        const angle = i * 2.399, radius = 17 + (i * 7 % 13);
        this.makeTree(29 + Math.cos(angle) * radius, 30 + Math.sin(angle) * radius, this.preview, i, i % 3 ? 'tree_oak' : 'tree_pine');
      }
      for (let i = 0; i < 7; i++) this.makeUnit(i < 4 ? 'villager' : 'militia', 27 + i * 1.1, 23 + i % 3, '#8ac6bd', this.preview);
    });
    this.resize = () => this.engine.resize();
    window.addEventListener('resize', this.resize);
    this.keyDown = (e) => {
      if (suppressGameplayHotkeys(e.target)) return;
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) e.preventDefault();
      this.keys.add(e.key.toLowerCase());
      if (matchesHotkey(e, 'cameraHome', this.preferences)) {
        const base = this.view?.entities.find((entity) => entity.ownerId === this.view?.playerId && entity.typeId === 'town_center');
        this.camera.target.set(base ? base.xMm / 1000 : 29, 0, base ? base.zMm / 1000 : 30);
        this.camera.movement.resetRotationVelocity(); this.camera.movement.resetPanVelocity(); this.camera.movement.resetZoomVelocity();
        this.camera.alpha = -Math.PI / 2.6; this.camera.beta = .82; this.camera.radius = this.view ? 45 : 47;
      }
    };
    this.keyUp = (e) => this.keys.delete(e.key.toLowerCase());
    window.addEventListener('keydown', this.keyDown);
    window.addEventListener('keyup', this.keyUp);
    this.contextLost = (e) => { e.preventDefault(); browserResponseProbe.observe(probe=>probe.boundary('graphics-context-lost')); onStatus('Graphics context lost. Waiting for your browser to restore WebGL2…'); };
    this.contextRestored = () => onStatus(null);
    canvas.addEventListener('webglcontextlost', this.contextLost);
    canvas.addEventListener('webglcontextrestored', this.contextRestored);
    this.engine.runRenderLoop(() => {
      const speed = Math.min(this.engine.getDeltaTime(), 50) * 0.024;
      const { forward, right } = cameraPanDirections(this.camera.alpha);
      if (heldPanKey(this.keys, 'panForward', this.preferences)) this.camera.target.addInPlace(forward.scale(speed));
      if (heldPanKey(this.keys, 'panBack', this.preferences)) this.camera.target.addInPlace(forward.scale(-speed));
      if (heldPanKey(this.keys, 'panLeft', this.preferences)) this.camera.target.addInPlace(right.scale(-speed));
      if (heldPanKey(this.keys, 'panRight', this.preferences)) this.camera.target.addInPlace(right.scale(speed));
      if (this.preferences.edgePan && this.pointerEdge && !this.pointerStart && !suppressGameplayHotkeys(document.activeElement)) {
        if (this.pointerEdge.x < 14) this.camera.target.addInPlace(right.scale(-speed));
        else if (this.pointerEdge.x > canvas.clientWidth - 14) this.camera.target.addInPlace(right.scale(speed));
        if (this.pointerEdge.y < 14) this.camera.target.addInPlace(forward.scale(speed));
        else if (this.pointerEdge.y > canvas.clientHeight - 14) this.camera.target.addInPlace(forward.scale(-speed));
      }
      this.camera.target.x = Math.max(0, Math.min((this.view?.map.widthMm ?? 64000) / 1000, this.camera.target.x));
      this.camera.target.z = Math.max(0, Math.min((this.view?.map.heightMm ?? 64000) / 1000, this.camera.target.z));
      const now = performance.now();
      const coarse = this.coarsePresentation(), presentationMs = coarse ? this.visualTick(now) * 1000 / balance.rules.simulationHz : 0;
      this.animateEntities(now, coarse, presentationMs);
      for (const projectile of this.projectiles.values()) {
        if (this.streamActive !== false) { const point = coarse ? projectile.motion.sampleAt(presentationMs) : projectile.motion.sample(now, this.view?.status === 'RUNNING', this.view?.simulationSpeed ?? 1); projectile.mesh.position.set(point.x, point.y, point.z); }
        projectile.mesh.setEnabled(this.visibleCells.has(Math.floor(projectile.mesh.position.z * 1000 / (this.view?.map.fogCellMm ?? 2000)) * this.fogColumns + Math.floor(projectile.mesh.position.x * 1000 / (this.view?.map.fogCellMm ?? 2000))));
      }
      const visualTick = this.visualTick(now);
      for (const [id, effect] of this.effects) {
        const seconds = Math.max(0, visualTick - effect.tick) / balance.rules.simulationHz, fraction = seconds / effect.duration;
        if (fraction >= 1) { effect.mesh.dispose(); this.effects.delete(id); }
        else { this.assets.update(effect.asset, { opacity: fraction > .75 ? (1-fraction)*4 : 1 }, { state: effect.death && effect.asset.asset.kind === 'building' ? 'destroyed' : 'complete', action: effect.death ? 'death' : 'hit' }, effect.death ? 'death' : 'idle', seconds);if(effect.wave){const radius=effect.wave.radius*(this.assets.reducedMotion?1:.3+.7*fraction)/effect.mesh.scaling.x;effect.wave.mesh.scaling.set(radius,1,radius);} }
      }
      for (const asset of this.terrainArt) asset.seconds = visualTick / balance.rules.simulationHz;
      const responseSubmitted=browserResponseProbe.enabled?(this.responseSubmitted??=new Map<AssetInstance,import('./AssetRenderer').AssetDrawEvidence>()):undefined;
      const releaseResponseDraw=this.assets?.render(this.camera.position,responseSubmitted);
      try{if(responseSubmitted)observeResponseRender(this.scene,()=>this.scene.render(),()=>{
        if(!this.view||!this.streamActive||document.visibilityState!=='visible')return;
        browserResponseProbe.observe(probe=>{
          const entities:ResponseRenderEntity[]=[];
          for(const entry of this.rendered.values())if(entry.entity.ownerId===this.view!.playerId&&!entry.entity.ghost&&entry.root.isEnabled()){
            const submitted=responseSubmitted.get(entry.asset);if(submitted?.drawn)entities.push({id:entry.id,xMm:entry.root.position.x*1000,zMm:entry.root.position.z*1000,clip:submitted.clip,...(entry.gatePose===undefined?{}:{gatePose:submitted.sampleTime})});
          }
          probe.rendered(this.view!,entities);
        });
      });else this.scene.render();}finally{releaseResponseDraw?.();}
      // A stationary pointer must follow camera motion and newly filtered views.
      // Bound picking to 10 Hz rather than adding it to every rendered frame.
      if (now - this.lastHoverAt >= 100) { this.lastHoverAt = now; this.refreshHover(); }
    });
    this.pointerDown = (e) => { if (this.view && e.button !== 1) { this.pointerStart = { x: e.offsetX, y: e.offsetY, button: e.button }; if (e.button === 0 && this.isWallPlacement()) { const point = this.pick(e.offsetX, e.offsetY, true); if (point) { this.wallStart = this.cell(point); this.updateWall(point, e.ctrlKey); } } } };
    this.pointerMove = (e) => {
      this.pointerEdge = { x: e.offsetX, y: e.offsetY };
      if (this.isWallPlacement()) this.updateWall(this.pick(e.offsetX, e.offsetY, true), e.ctrlKey);
      else if (this.placement) this.updatePlacement(this.pick(e.offsetX, e.offsetY, true));
      if (this.pointerStart?.button === 0 && !this.placement && !this.rallyBuilding && !this.targetMode && Math.hypot(e.offsetX - this.pointerStart.x, e.offsetY - this.pointerStart.y) > 6) {
        this.onDrag({ x: Math.min(e.offsetX, this.pointerStart.x), y: Math.min(e.offsetY, this.pointerStart.y), width: Math.abs(e.offsetX - this.pointerStart.x), height: Math.abs(e.offsetY - this.pointerStart.y) });
      }
    };
    this.pointerUp = (e) => {
      const start = this.pointerStart; this.pointerStart = null; this.onDrag(null);
      if (!this.view || !start) return;
      let target = this.pick(e.offsetX, e.offsetY, !!this.placement);
      if (this.targetMode && this.wallTargetType && !target?.id) target = this.pickWallVolume(e.offsetX, e.offsetY, target) ?? target;
      if (e.button === 2) { if (target) this.onOrder(target, e.shiftKey); return; }
      if (e.button !== 0) return;
      if (this.targetMode) { if (target) this.onTarget(target, e.shiftKey); return; }
      if (this.isWallPlacement()) { if (target) this.updateWall(target, e.ctrlKey); if (this.wallCells.length <= 64) this.onWall(this.wallCells, e.shiftKey); this.wallStart = null; return; }
      if (this.rallyBuilding) { if (target) { this.onRally(this.rallyBuilding, target); this.rallyBuilding = null; } return; }
      if (this.placement) { if (target) this.onBuild(target, e.shiftKey); return; }
      if (Math.hypot(e.offsetX - start.x, e.offsetY - start.y) > 6) {
        const ids: string[] = [];
        for (const entity of this.view.entities) {
          if (entity.kind !== 'unit' || entity.ownerId !== this.view.playerId || entity.ghost || entity.garrisonedIn) continue;
          const position = this.screenPosition(entity.id);
          if (position && position.x >= Math.min(start.x, e.offsetX) && position.x <= Math.max(start.x, e.offsetX) && position.y >= Math.min(start.y, e.offsetY) && position.y <= Math.max(start.y, e.offsetY)) ids.push(entity.id);
        }
        this.select(e.shiftKey ? [...new Set([...this.selected, ...ids])] : ids);
      } else {
        const id = target?.id;
        this.select(id ? e.shiftKey ? this.selected.includes(id) ? this.selected.filter((value) => value !== id) : [...this.selected, id] : [id] : e.shiftKey ? this.selected : []);
      }
    };
    this.doubleClick = (e) => {
      const target = this.pick(e.offsetX, e.offsetY);
      const entity = this.view?.entities.find((entry) => entry.id === target?.id);
      if (entity?.kind === 'unit' && entity.ownerId === this.view?.playerId) this.select(this.view.entities.filter((entry) => entry.typeId === entity.typeId && entry.ownerId === entity.ownerId && !entry.garrisonedIn).map((entry) => entry.id));
    };
    this.contextMenu = (e) => e.preventDefault();
    this.pointerLeave = () => { this.pointerEdge = null; this.refreshHover(); };
    this.blur = () => { this.keys.clear(); this.pointerEdge = null; this.refreshHover(); };
    this.focusIn = event => { if (suppressGameplayHotkeys(event.target)) this.blur(); };
    canvas.addEventListener('pointerleave', this.pointerLeave);
    window.addEventListener('blur', this.blur);
    window.addEventListener('focusin', this.focusIn);
    canvas.addEventListener('pointerdown', this.pointerDown);
    canvas.addEventListener('pointerup', this.pointerUp);
    canvas.addEventListener('pointermove', this.pointerMove);
    canvas.addEventListener('dblclick', this.doubleClick);
    canvas.addEventListener('contextmenu', this.contextMenu);
  }

  private material(name: string, hex: string): StandardMaterial {
    const existing = this.materials.get(name);
    if (existing) return existing;
    const material = new StandardMaterial(name, this.scene);
    material.diffuseColor = Color3.FromHexString(hex);
    material.specularColor = new Color3(0.08, 0.08, 0.08);
    if (name.startsWith('team-') && typeof document !== 'undefined') {
      const pattern = this.view?.players.find((player) => player.color === hex)?.pattern;
      if (pattern !== undefined) {
        const texture = new DynamicTexture(`banner-pattern-${pattern}`, { width: 128, height: 128 }, this.scene, false);
        const context = texture.getContext(); context.fillStyle = hex; context.fillRect(0, 0, 128, 128); context.fillStyle = '#eef0d7'; context.strokeStyle = '#eef0d7'; context.lineWidth = 14;
        const line = (x: number, y: number, dx: number, dy: number) => { context.beginPath(); context.moveTo(x, y); context.lineTo(dx, dy); context.stroke(); };
        if (pattern === 0) line(10, 118, 118, 10);
        else if (pattern === 1) { line(64, 8, 64, 120); line(8, 64, 120, 64); }
        else if (pattern === 2) { line(8, 90, 64, 32); line(64, 32, 120, 90); }
        else if (pattern === 3) for (const y of [28, 64, 100]) line(12, y, 116, y);
        else if (pattern === 4) { line(12, 12, 116, 116); line(116, 12, 12, 116); }
        else if (pattern === 5) for (const x of [30, 64, 98]) for (const y of [30, 64, 98]) { context.beginPath(); context.arc(x, y, 8, 0, Math.PI * 2); context.fill(); }
        else if (pattern === 6) { context.beginPath(); context.moveTo(64, 15); context.lineTo(113, 64); context.lineTo(64, 113); context.lineTo(15, 64); context.closePath(); context.stroke(); }
        else if (pattern === 7) { line(16, 105, 50, 105); line(50, 105, 50, 66); line(50, 66, 85, 66); line(85, 66, 85, 23); line(85, 23, 118, 23); }
        else if (pattern === 8) { for (let i = 0; i < 8; i++) line(64 + Math.cos(i * Math.PI / 4) * 22, 64 + Math.sin(i * Math.PI / 4) * 22, 64 + Math.cos(i * Math.PI / 4) * 50, 64 + Math.sin(i * Math.PI / 4) * 50); }
        else if (pattern === 9) { context.beginPath(); context.moveTo(64, 15); context.lineTo(113, 108); context.lineTo(15, 108); context.closePath(); context.stroke(); }
        else for (const radius of [19, 44]) { context.beginPath(); context.arc(64, 64, radius, 0, Math.PI * 2); context.stroke(); }
        texture.update(); material.diffuseTexture = texture; material.diffuseColor = Color3.White();
      }
    }
    this.materials.set(name, material);
    return material;
  }

  private part(mesh: Mesh, parent: TransformNode, material: StandardMaterial, x: number, y: number, z: number): Mesh {
    mesh.parent = parent;
    mesh.position.set(x, y, z);
    mesh.material = material;
    this.shadows.addShadowCaster(mesh);
    mesh.receiveShadows = true;
    return mesh;
  }

  makeBuilding(type: string, x: number, z: number, color: string, parent?: TransformNode): TransformNode {
    return this.createArt(type, x, z, color, parent);
  }
  private createArt(type: string, x: number, z: number, color: string, parent?: TransformNode): TransformNode {
    const instance = this.assets.create(type, { color, age: 1, tier: 'base', pattern: 0 }, parent);
    instance.root.position.set(x, 0, z); return instance.root;
  }
  setPreferences(preferences: Pick<Preferences, 'quality'|'reducedMotion'|'edgePan'|'bindings'>): void {
    this.preferences = { ...this.preferences, ...preferences };
    const resolution = { low: .65, medium: .85, high: 1 }[preferences.quality];
    this.engine.setHardwareScalingLevel(1 / resolution);
    this.scene.shadowsEnabled = preferences.quality !== 'low';
    if (this.assets) { this.assets.quality = preferences.quality; this.assets.reducedMotion = preferences.reducedMotion; }
  }
  private coarsePresentation(): boolean { return (this.view?.authoritativeIntervalMs ?? 0) >= 300 || (this.view?.publicationIntervalMs ?? 0) >= 300; }
  /** Scalar presentation only. Commands and economic decisions use the view. */
  presentationTimeMs(now=performance.now()):number { return Math.min(this.view?.committedTimeMs??(this.view?.tick??0)*1000/balance.rules.simulationHz,this.visualTick(now)*1000/balance.rules.simulationHz); }
  presentationProgress(id:string,jobId?:string):number|undefined {
    const entry=this.rendered.get(id);if(!entry)return;
    const track=jobId===undefined?entry.construction:entry.jobs?.get(jobId)?.track;
    return track?.sampleAt(this.presentationTimeMs());
  }
  private visualTick(now: number): number {
    const view = this.view;
    if (!view) return 0;
    if (this.coarsePresentation()) return (this.presentationClock?.sample(now, view.simulationSpeed ?? 1, this.streamActive !== false && view.status === 'RUNNING') ?? view.tick * 1000 / balance.rules.simulationHz) * balance.rules.simulationHz / 1000;
    const elapsedGameMs = Math.min(100, Math.max(0, now - this.receivedViewAt)) * (view.simulationSpeed ?? 1);
    return view.tick + (this.streamActive && view.status === 'RUNNING' ? elapsedGameMs * balance.rules.simulationHz / 1000 : 0);
  }
  private animateEntities(now: number, coarse: boolean, presentationMs: number): void {
    for (const entry of this.rendered.values()) {
      // Natural resources have no animated tracks or health display. Their
      // appearance, fog memory, selection and depletion still update on every
      // committed view; static copies need no display-frame pose allocations.
      if (entry.staticResource) continue;
      let trajectoryFacing = false;
      if (this.streamActive !== false && entry.moving) {
        const point = coarse ? entry.motion.sampleAt(presentationMs) : entry.motion.sample(now, this.view?.status === 'RUNNING', this.view?.simulationSpeed ?? 1);
        const visible = this.visibleCells.has(Math.floor(point.z * 1000 / (this.view?.map.fogCellMm ?? 2000)) * this.fogColumns + Math.floor(point.x * 1000 / (this.view?.map.fogCellMm ?? 2000)));
        entry.root.setEnabled(visible); entry.ring.setEnabled(visible && this.selected.includes(entry.id));
        if (visible) {
          if (coarse && Math.hypot(point.x - entry.root.position.x, point.z - entry.root.position.z) > .0001) { entry.root.rotation.y = Math.atan2(point.x - entry.root.position.x, point.z - entry.root.position.z); trajectoryFacing = true; }
          entry.root.position.set(point.x, point.y, point.z);
        }
        entry.ring.position.set(entry.root.position.x, entry.root.position.y + 0.12, entry.root.position.z);
      }
      this.animate(entry, now, trajectoryFacing);
      entry.health.setEnabled(entry.healthEligible && (this.keys.has(this.preferences.bindings.health) || this.selected.includes(entry.id)));
    }
  }

  private animate(entry: RenderEntity, now: number, trajectoryFacing = false): void {
    if (!this.view || !this.assets) return;
    const entity = entry.entity;
    const tick = entity.ghost ? entity.lastSeenTick ?? this.view.tick : this.visualTick(now);
    let visualAction = entity.visualAction;
    if (this.coarsePresentation() && !entity.ghost) {
      visualAction = undefined;
      const history = entry.actionHistory ?? [];
      for (let index = history.length - 1; index >= 0; index--) if ((history[index]!.presentedTick ?? history[index]!.startedTick) <= tick) { visualAction = history[index]; break; }
      if (entity.kind === 'unit' && !entity.garrisonedIn && !trajectoryFacing && visualAction?.facingMilliRad !== undefined) entry.root.rotation.y = visualAction.facingMilliRad / 1000;
    }
    let action = visualAction?.kind ?? 'idle', seconds = Math.max(0, tick - (visualAction?.startedTick ?? tick)) / balance.rules.simulationHz;
    let clip: string = action;
    if (visualAction?.durationTicks && tick > visualAction.startedTick + visualAction.durationTicks) { clip = 'idle'; seconds = 0; }
    if(entity.typeId==='crown_colossus'&&entry.turretTick!==undefined&&tick>=entry.turretTick&&tick-entry.turretTick<.7*balance.rules.simulationHz&&(clip==='idle'||clip==='attack')){clip='turret';seconds=(tick-entry.turretTick)/balance.rules.simulationHz;}
    if (entity.deploymentState === 'packed') { clip = 'packed'; seconds = 0; }
    else if (entity.deploymentState === 'deploying' || entity.deploymentState === 'packing') { clip = entity.deploymentState === 'deploying' ? 'deploy' : 'pack'; seconds = (entity.deploymentProgress ?? 0) * (clip==='deploy'?(units[entity.typeId]?.deploySeconds??4):(units[entity.typeId]?.packSeconds??3)); }
    if(entity.windup&&units[entity.typeId]?.windupSeconds){clip='windup';seconds=Math.max(0,units[entity.typeId]!.windupSeconds!-entity.windup.remainingTicks/balance.rules.simulationHz);}
    if (entry.hitTick !== undefined && tick - entry.hitTick < balance.rules.simulationHz * .36) { clip = 'hit'; seconds = Math.max(0, tick - entry.hitTick) / balance.rules.simulationHz; }
    let presentedGateOpen=entity.gateOpen;
    if (entity.typeId.endsWith('_gate')) {
      clip = 'gate_open'; const duration = entry.asset.asset.clips.find(c=>c.id===clip)?.durationSeconds ?? .4, target = entity.gateOpen ? 1 : 0;
      if(this.coarsePresentation()&&!entity.ghost&&entry.gateHistory){const sample=entry.gateHistory.sampleAt(tick);entry.gatePose=sample.pose;presentedGateOpen=sample.open;}
      else{const progress = entry.gateTick === undefined ? 1 : Math.max(0,Math.min(1,(tick-entry.gateTick)/balance.rules.simulationHz/duration));entry.gatePose = (entry.gateFrom ?? target) + (target-(entry.gateFrom ?? target))*progress;}
      seconds = entry.gatePose*duration;
    }
    if (entity.kind === 'building' && (entity.progress ?? 1) >= 1 && entity.hp / entity.maxHp < ((this.preferences?.quality ?? 'high') === 'low' ? .25 : .5)) {
      const type = entity.hp / entity.maxHp < .25 ? 'fire' : 'smoke';
      if (entry.ambient?.asset.id !== type) { entry.ambient?.root.dispose(); entry.ambient = this.assets.create(type, { ghost: !!entity.ghost }, entry.root); entry.ambient.pickable = false; entry.ambient.root.position.y = Math.min(3,entry.asset.asset.bounds.max[1]*.65); }
      this.assets.update(entry.ambient, { ghost: !!entity.ghost }, {}, 'idle', tick / balance.rules.simulationHz);
    } else if (entry.ambient) { entry.ambient.root.dispose(); entry.ambient = undefined; }
    this.assets.update(entry.asset, {}, { action:entity.windup?'windup':action, progress: entity.progress ?? 1, damage: 1 - entity.hp / Math.max(1,entity.maxHp), state: (entity.progress ?? 1) <= .01 ? 'foundation' : (entity.progress ?? 1) < 1 ? 'construction' : entity.hp / Math.max(1,entity.maxHp) < .6 ? 'damaged' : 'complete', farm: entity.farmState ?? 'ready', gate: presentedGateOpen ? 'open' : 'closed', wallMask: entry.wallMask, ...(entity.ownerId === this.view.playerId && entity.cargo?.resource ? { cargo: entity.cargo.resource } : {}) }, clip, seconds);
  }

  private elevation(xMm: number, zMm: number): number { return terrainHeightAt(this.view?.map.terrain ?? [], xMm, zMm) / 1000; }

  private makeTerrain(view: PlayerView): void {
    this.terrainDetail?.dispose(); this.terrainDetail = new TransformNode('public-landforms', this.scene);
    // Mountain feet use their exact collision bounds. Sampling them into the
    // general ground grid would spread apparent rock slopes into clear valleys.
    this.groundTerrain = (view.map.terrain ?? []).filter(region => region.kind !== 'ridge'); this.ridgeFaces = [];
    const width = view.map.widthMm / 1000, depth = view.map.heightMm / 1000, columns = Math.ceil(width / 2), rows = Math.ceil(depth / 2);
    const positions: number[] = [], indices: number[] = [], normals: number[] = [], colors: number[] = [];
    for (let z = 0; z <= rows; z++) for (let x = 0; x <= columns; x++) {
      const worldX = x / columns * width, worldZ = z / rows * depth, height = terrainHeightAt(this.groundTerrain, worldX * 1000, worldZ * 1000) / 1000;
      positions.push(worldX, height, worldZ);
      const shade = ((x * 13 + z * 7) % 11) * 0.0015;
      colors.push(0.41 + shade, 0.47 + shade, 0.33 + shade, 1);
      if (x < columns && z < rows) { const a = z * (columns + 1) + x, b = a + columns + 1; indices.push(a, a + 1, b, a + 1, b + 1, b); }
    }
    VertexData.ComputeNormals(positions, indices, normals);
    const data = new VertexData(); data.positions = positions; data.indices = indices; data.normals = normals; data.colors = colors;
    this.ground = new Mesh('known-landform', this.scene); data.applyToMesh(this.ground); this.ground.material = this.material('landform', '#ffffff'); this.ground.receiveShadows = true;
    this.terrainArt = [];
    for (const region of view.map.terrain ?? []) {
      if (region.kind === 'ridge') { this.makeRidge(region, view); continue; }
      if (region.kind !== 'water' && region.kind !== 'bridge') continue;
      const instance = this.assets.create(region.kind === 'water' ? 'water_surface' : 'bridge', {}, this.terrainDetail);
      instance.pickable = false; instance.clip = 'idle'; this.terrainArt.push(instance);
      instance.root.position.set((region.xMm + region.widthMm / 2) / 1000, region.kind === 'water' ? -.04 : region.elevationMm / 1000 - .37, (region.zMm + region.depthMm / 2) / 1000);
      instance.root.scaling.set(region.widthMm / (region.kind === 'water' ? 2000 : 6000), 1, region.depthMm / (region.kind === 'water' ? 2000 : 4000));
    }
  }

  private makeRidge(region: TerrainRegion & { elevationMm: number }, view: PlayerView): void {
    const positions: number[] = [], indices: number[] = [], normals: number[] = [], colors: number[] = [];
    const fogSize = view.map.fogCellMm, columns = Math.ceil(view.map.widthMm / fogSize);
    const coordinates = (begin: number, length: number): number[] => {
      const result = [begin];
      for (let value = (Math.floor(begin / fogSize) + 1) * fogSize; value < begin + length; value += fogSize) result.push(value);
      result.push(begin + length); return result;
    };
    const xs = coordinates(region.xMm, region.widthMm), zs = coordinates(region.zMm, region.depthMm);
    const point = (x: number, z: number): number[] => [x / 1000, ridgeHeightAt(region, x, z) / 1000, z / 1000];
    const face = (points: number[], x: number, z: number, wall = false): void => {
      const start = positions.length / 3, shade = ((Math.floor(x / fogSize) * 13 + Math.floor(z / fogSize) * 7) % 7) * .006;
      positions.push(...points); indices.push(start, start + 1, start + 3, start + 1, start + 2, start + 3);
      for (let i = 0; i < 4; i++) {
        const height = points[i * 3 + 1]! * 1000 / Math.max(1, region.elevationMm), light = (wall ? -.055 : 0) + height * .13 + shade;
        colors.push(.35 + light, .34 + light, .30 + light, 1);
      }
      this.ridgeFaces.push({ positions: points, fogCell: Math.floor(z / fogSize) * columns + Math.floor(x / fogSize) });
    };
    for (let z = 0; z + 1 < zs.length; z++) for (let x = 0; x + 1 < xs.length; x++) {
      const left = xs[x]!, right = xs[x + 1]!, top = zs[z]!, bottom = zs[z + 1]!;
      face([...point(left, top), ...point(right, top), ...point(right, bottom), ...point(left, bottom)], (left + right) / 2, (top + bottom) / 2);
    }
    // Vertical rock skirts are inside the collision rectangle, including at pass
    // mouths. No decorative boulders or overhangs narrow the traversable space.
    for (let x = 0; x + 1 < xs.length; x++) for (const z of [zs[0]!, zs[zs.length - 1]!]) {
      const left = xs[x]!, right = xs[x + 1]!;
      face([left / 1000, 0, z / 1000, right / 1000, 0, z / 1000, ...point(right, z), ...point(left, z)], (left + right) / 2, z === zs[0] ? z + .5 : z - .5, true);
    }
    for (let z = 0; z + 1 < zs.length; z++) for (const x of [xs[0]!, xs[xs.length - 1]!]) {
      const top = zs[z]!, bottom = zs[z + 1]!;
      face([x / 1000, 0, top / 1000, x / 1000, 0, bottom / 1000, ...point(x, bottom), ...point(x, top)], x === xs[0] ? x + .5 : x - .5, (top + bottom) / 2, true);
    }
    VertexData.ComputeNormals(positions, indices, normals);
    const data = new VertexData(); data.positions = positions; data.indices = indices; data.normals = normals; data.colors = colors;
    const mesh = new Mesh(`rocky-ridge-${region.id}`, this.scene); data.applyToMesh(mesh); mesh.parent = this.terrainDetail;
    const material = this.material('rocky-ridge', '#ffffff'); material.backFaceCulling = false;
    mesh.material = material; mesh.receiveShadows = true; mesh.metadata = { terrain: true };
  }

  setStreamActive(active: boolean): void {
    this.streamActive = active;
    if (!active) { for (const entry of this.rendered.values()) entry.motion.freeze(entry.root.position); for (const entry of this.projectiles.values()) entry.motion.freeze(entry.mesh.position); }
  }

  setPings(pings: TeamPing[], tick: number): void {
    const active = pings.filter((ping) => this.view && ping.expiresTick > tick), ids = new Set(active.map((ping) => ping.id));
    for (const [id, root] of this.pingMeshes) if (!ids.has(id)) { root.dispose(); this.pingMeshes.delete(id); }
    for (const ping of active) {
      if (this.pingMeshes.has(ping.id)) continue;
      const root = new TransformNode(`team-ping-${ping.id}`, this.scene), color = ping.category === 'attack' ? '#dca17c' : ping.category === 'defend' ? '#9ec9c4' : ping.category === 'resource' ? '#dac986' : '#ddc1df';
      const material = this.material(`ping-${ping.category}`, color); material.emissiveColor = Color3.FromHexString(color).scale(0.65); material.alpha = 0.9;
      const ring = MeshBuilder.CreateTorus(`signal-${ping.category}`, { diameter: 4, thickness: 0.15, tessellation: ping.category === 'defend' ? 4 : ping.category === 'attack' ? 3 : 32 }, this.scene); ring.parent = root; ring.material = material;
      const mark = ping.category === 'resource' ? MeshBuilder.CreatePolyhedron('signal-resource-marker', { type: 1, size: 0.4 }, this.scene) : MeshBuilder.CreateCylinder('signal-coordinate-marker', { diameterTop: 0.1, diameterBottom: 0.35, height: 1.6, tessellation: 6 }, this.scene);
      mark.parent = root; mark.position.y = 0.8; mark.material = material;
      for (const mesh of root.getChildMeshes()) { mesh.isPickable = false; mesh.renderingGroupId = 2; }
      root.position.set(ping.xMm / 1000, this.elevation(ping.xMm, ping.zMm) + 0.3, ping.zMm / 1000); this.pingMeshes.set(ping.id, root);
    }
  }

  setView(view: PlayerView, resetInterpolation = false): void {
    const timelineChanged = !this.view || this.view.matchId !== view.matchId || this.view.matchEpoch !== view.matchEpoch || this.view.playerId !== view.playerId || view.tick < this.view.tick;
    resetInterpolation ||= timelineChanged;
    if (timelineChanged) { for (const effect of this.effects.values()) effect.mesh.dispose(); this.effects.clear(); this.seenEffects.clear(); }
    const first = !this.view || this.view.matchId !== view.matchId;
    if (first) {
      this.preview.setEnabled(false);
      for (const entry of this.rendered.values()) { entry.root.dispose(); entry.ring.dispose(); }
      this.rendered.clear(); this.ground?.dispose(); this.fogMesh?.dispose(); this.lastFog = '';
      this.makeTerrain(view);
      this.camera.radius = 45;
      this.camera.upperRadiusLimit = Math.max(view.map.widthMm, view.map.heightMm) / 900;
      const base = view.entities.find((entity) => entity.ownerId === view.playerId && entity.typeId === 'town_center');
      if (base) this.camera.target.set(base.xMm / 1000, 0, base.zMm / 1000);
    }
    this.view = view; this.receivedViewAt = performance.now();
    (this.presentationClock ??= new PresentationClock()).push(view.committedTimeMs ?? view.tick * 1000 / balance.rules.simulationHz, this.receivedViewAt, view.publicationIntervalMs, resetInterpolation);
    this.visibleCells = new Set(view.fog.visible); this.fogColumns = Math.ceil(view.map.widthMm / view.map.fogCellMm);
    const wallOccupancy = new Set<string>();
    for (const object of view.entities) if (object.typeId.endsWith('_wall') || object.typeId.endsWith('_gate')) {
      const cell = this.cell(object), span = object.typeId.endsWith('_gate') ? (buildings[object.typeId]?.wallEquivalentCells===5?[-2,-1,0,1,2]:[-1,0,1]) : [0];
      for (const offset of span) wallOccupancy.add(`${object.ownerId}:${cell.x + ((object.rotation ?? 0) % 180 ? 0 : offset)}:${cell.z + ((object.rotation ?? 0) % 180 ? offset : 0)}`);
    }
    // Exhausted natural nodes remain in authorized resource/history records, but
    // their former footprint is buildable. Remove their art and picking/selection
    // only after this recipient observes zero. Farms remain available to reseed.
    const drawableEntities = view.entities.filter(entity => !(entity.kind === 'resource' && entity.amount === 0));
    const liveIds = new Set(drawableEntities.map((entity) => entity.id));
    for (const [id, entry] of this.rendered) if (!liveIds.has(id)) { entry.root.dispose(); entry.ring.dispose(); this.rendered.delete(id); }
    for (const entity of drawableEntities) {
      let entry = this.rendered.get(entity.id);
      if (!entry) {
        const color = view.players.find((player) => player.id === entity.ownerId)?.color ?? '#a5b68a';
        const root = entity.kind === 'unit' ? this.makeUnit(entity.typeId, entity.xMm / 1000, entity.zMm / 1000, color) : entity.kind === 'building' ? this.makeBuilding(entity.typeId, entity.xMm / 1000, entity.zMm / 1000, color) : entity.resource === 'wood' ? this.makeTree(entity.xMm / 1000, entity.zMm / 1000, undefined, entity.id.charCodeAt(0), entity.typeId) : this.makeResource(entity);
        for (const mesh of root.getChildMeshes()) mesh.metadata = { entityId: entity.id };
        const diameter = entity.kind === 'building' ? Math.max(...(buildings[entity.typeId]?.footprintCells ?? [2, 2])) * balance.rules.buildingGridM + 1 : entity.forest ? entity.forest.cellMm / 1000 * Math.SQRT2 : entity.kind === 'resource' ? 3 : Math.max(1.5,(units[entity.typeId]?.collisionRadiusM??.5)*2+.3);
        const ring = MeshBuilder.CreateTorus('selection-ring', { diameter, thickness: 0.09, tessellation: entity.forest ? 4 : 32 }, this.scene);
        if(entity.forest)ring.rotation.y=Math.PI/4;
        ring.material = this.material('selection', '#ebd69e'); ring.isPickable = false; ring.position.set(entity.xMm / 1000, 0.12, entity.zMm / 1000);
        const health = MeshBuilder.CreatePlane('health-background', { width: entity.kind === 'building' ? 3 : 1.5, height: 0.13 }, this.scene); health.parent = root; health.position.y = entity.kind === 'building' ? 5.6 : entity.typeId === 'trebuchet' ? 4 : 2.25; health.billboardMode = Mesh.BILLBOARDMODE_ALL; health.isPickable = false; health.material = this.material('health-background', '#172622');
        const healthFill = MeshBuilder.CreatePlane('health-current', { width: entity.kind === 'building' ? 2.95 : 1.45, height: 0.095 }, this.scene); healthFill.parent = health; healthFill.position.z = -0.015; healthFill.isPickable = false; healthFill.material = this.material('health-current', '#b4d290'); health.setEnabled(false);
        const asset = this.assets.instances.get(root)!;
        entry = { asset, entity, staticResource: entity.kind === 'resource' && asset.asset.clips.every(clip => !clip.tracks.length), wallMask: 5, motion: new MotionTrack(), moving: false, id: entity.id, root, ring, health, healthFill, healthEligible: entity.kind !== 'resource', from: root.position.clone(), target: root.position.clone(), received: performance.now(), hp: entity.hp };
        this.rendered.set(entity.id, entry);
      }
      if(entry.asset.asset.id!==entity.typeId&&entity.kind!=='resource')this.assets.replace(entry.asset,entity.typeId);
      if (resetInterpolation) { entry.gateTick = undefined; entry.gatePose = entity.gateOpen ? 1 : 0; entry.gateFrom = entry.gatePose; }
      else if (entry.entity.gateOpen !== entity.gateOpen) { entry.gateTick = view.tick; entry.gateFrom = entry.gatePose ?? (entry.entity.gateOpen ? 1 : 0); }
      const priorEntity=entry.entity,resetPose=resetInterpolation||!!entity.ghost||!!priorEntity.ghost||!!entity.garrisonedIn||!!priorEntity.garrisonedIn;
      if(resetPose)entry.turretTick=undefined;
      else if(entity.typeId==='crown_colossus'&&(entity.weaponCooldowns?.[0]??0)>(priorEntity.weaponCooldowns?.[0]??0))entry.turretTick=view.tick-Math.max(0,Math.ceil(units.crown_colossus!.turret!.attackCooldownSeconds*balance.rules.simulationHz)-entity.weaponCooldowns![0]!);
      entry.entity = entity;
      const committedProgressMs=view.committedTimeMs??view.tick*1000/balance.rules.simulationHz;
      if(entity.kind==='building'&&!entity.ghost){
        if(entity.progress!==undefined)(entry.construction??=new ProgressTrack()).push(entity.progress,committedProgressMs,resetPose);
        const jobs=entry.jobs??=new Map(),ids=new Set((entity.queue??[]).map(job=>job.id));
        for(const id of jobs.keys())if(!ids.has(id))jobs.delete(id);
        for(const job of entity.queue??[]){let prior=jobs.get(job.id);const reset=resetPose||!prior||prior.kind!==job.kind||prior.typeId!==job.typeId||prior.state!=='active'||job.state!=='active';if(!prior){prior={kind:job.kind,typeId:job.typeId,state:job.state,track:new ProgressTrack()};jobs.set(job.id,prior);}prior.track.push(job.progress,committedProgressMs,reset);prior.kind=job.kind;prior.typeId=job.typeId;prior.state=job.state;}
      }else{entry.construction=undefined;entry.jobs=undefined;}
      if (resetPose) entry.actionHistory = [];
      const visualTrace=!resetPose?entity.visualTrace:undefined;
      if(visualTrace){
        const history=entry.actionHistory??=[];
        if(visualTrace.complete)entry.actionHistory=history.filter(action=>(action.presentedTick??action.startedTick)<visualTrace.fromTick);
        for(const point of visualTrace.complete?visualTrace.points:[visualTrace.points.at(-1)!]){
          const action=point.visualAction??{kind:'idle' as const,startedTick:point.tick},entries=entry.actionHistory??=[],last=entries.at(-1);
          if(!last||last.kind!==action.kind||last.startedTick!==action.startedTick||last.durationTicks!==action.durationTicks||last.facingMilliRad!==action.facingMilliRad)entries.push({...action,presentedTick:point.tick});
          entry.actionHistory=entries.slice(-16);
        }
      } else if (entity.visualAction) {
        const history = entry.actionHistory ??= [], last = history.at(-1);
        const action = entity.visualAction;
        if (!last || last.kind !== action.kind || last.startedTick !== action.startedTick || last.durationTicks !== action.durationTicks || last.facingMilliRad !== action.facingMilliRad) {
          // A work bearing can change without restarting its animation. Its
          // exact change time is unknown, so reveal it only at the sampled tick.
          history.push({ ...action, ...(last?.startedTick === action.startedTick ? { presentedTick: view.tick } : {}) }); entry.actionHistory = history.slice(-16);
        }
      }
      if(entity.typeId.endsWith('_gate')&&this.coarsePresentation()&&!entity.ghost){
        const duration=entry.asset.asset.clips.find(clip=>clip.id==='gate_open')?.durationSeconds??.4;
        (entry.gateHistory??=new GateTrack(duration*balance.rules.simulationHz)).push(!!entity.gateOpen,view.tick,visualTrace,resetPose);
      }else entry.gateHistory=undefined;
      const owner = view.players.find(player => player.id === entity.ownerId);
      this.assets.update(entry.asset, { age: entity.visualAge ?? 1, tier: entity.visualTier ?? 'base', color: owner?.color ?? '#a5b68a', pattern: owner?.pattern ?? 0, ghost: !!entity.ghost, opacity: entity.pendingConstruction ? .4 : 1, depletedFood: entity.resource === 'food' && (entity.amount === 0 || entity.farmState === 'exhausted' || entity.farmState === 'reseeding') });
      const height = this.elevation(entity.xMm, entity.zMm);
      entry.from.copyFrom(entry.target); entry.target.set(entity.xMm / 1000, height, entity.zMm / 1000); entry.received = performance.now();
      entry.moving = entity.kind === 'unit' && !entity.ghost && !entity.garrisonedIn;
      entry.motion.setPublicationInterval(view.publicationIntervalMs);
      const committedMs = view.committedTimeMs ?? view.tick * 1000 / balance.rules.simulationHz;
      if (this.coarsePresentation()) entry.motion.pushTrace(entry.target, committedMs, entry.received, entity.motionTrace && !entity.ghost ? { complete: entity.motionTrace.complete, points: entity.motionTrace.points.map(point => ({ time: point.tick * 1000 / balance.rules.simulationHz, x: point.xMm / 1000, y: this.elevation(point.xMm, point.zMm), z: point.zMm / 1000 })) } : undefined, resetInterpolation || !!entity.ghost);
      else entry.motion.push(entry.target, committedMs, entry.received, resetInterpolation);
      if (resetInterpolation || !entry.moving) entry.root.position.copyFrom(entry.target);
      if (view.status !== 'RUNNING') entry.motion.freeze(entry.root.position);
      if (entity.kind !== 'unit') entry.root.rotation.y = (entity.rotation ?? 0) * Math.PI / 180;
      else if (entity.visualAction?.facingMilliRad !== undefined && (!this.coarsePresentation() || !entry.moving || resetInterpolation)) entry.root.rotation.y = entity.visualAction.facingMilliRad / 1000;
      else if ((!this.coarsePresentation() || resetInterpolation) && Vector3.DistanceSquared(entry.from, entry.target) > 0.001) entry.root.rotation.y = Math.atan2(entry.target.x - entry.from.x, entry.target.z - entry.from.z);
      entry.ring.position.set(entity.xMm / 1000, height + 0.12, entity.zMm / 1000);
      entry.ring.setEnabled(!entity.garrisonedIn && this.selected.includes(entity.id)); entry.root.setEnabled(!entity.garrisonedIn);
      if((buildings[entity.typeId]?.minAge??units[entity.typeId]?.minAge??1)>=5)entry.health.position.y=entry.asset.asset.bounds.max[1]+.35;
      if(entity.ward&&!entry.wardBar){const bar=MeshBuilder.CreatePlane('ward-background',{width:3,height:.13},this.scene),fill=MeshBuilder.CreatePlane('ward-current',{width:2.95,height:.095},this.scene);bar.parent=entry.health;bar.position.y=-.21;bar.isPickable=false;bar.material=this.material('health-background','#172622');fill.parent=bar;fill.position.z=-.015;fill.isPickable=false;fill.material=this.material('ward-current','#81bba9');entry.wardBar=bar;entry.wardFill=fill;}
      entry.wardBar?.setEnabled(!!entity.ward&&!entity.ghost);if(entry.wardFill)entry.wardFill.scaling.x=entity.ward?.max?Math.max(0,entity.ward.current/entity.ward.max):0;
      entry.healthEligible = entity.kind !== 'resource' && !entity.ghost && !entity.garrisonedIn; entry.healthFill.scaling.x = entity.maxHp ? Math.max(0, entity.hp / entity.maxHp) : 1;
      if (entity.typeId.endsWith('_wall')) {
        const cell = this.cell(entity); entry.wallMask = [[1,0,1],[0,1,2],[-1,0,4],[0,-1,8]].reduce((mask,[dx,dz,bit]) => wallOccupancy.has(`${entity.ownerId}:${cell.x+dx!}:${cell.z+dz!}`) ? mask+bit! : mask,0) || 5;
      }
      this.animate(entry, performance.now());
      entry.hp = entity.hp;
    }
    const surviving = this.selected.filter((id) => liveIds.has(id));
    if (surviving.length !== this.selected.length) this.select(surviving);
    this.updateFog(view);
    this.updateRallyMarker();
    this.updateSelectionIndicators();
    this.updateCombatVisuals(view, resetInterpolation);
    // Revalidate the held preview against each newly authorized view even when
    // the pointer has not moved. Reuse its target and geometry; no frame polling.
    if (this.placement && this.placementTarget) {
      if (this.isWallPlacement()) this.updateWall(this.placementTarget, this.wallZFirst);
      else this.updatePlacement(this.placementTarget);
    }
  }

  showLobby(): void {
    this.view = null; this.select([]); this.setPlacement(null);
    for (const entry of this.rendered.values()) { entry.root.dispose(); entry.ring.dispose(); }
    this.rendered.clear(); this.ground?.dispose(); this.ground = null; this.fogMesh?.dispose(); this.fogMesh = null; this.lastFog = '';
    this.terrainDetail?.dispose(); this.terrainDetail = null; this.rallyMarker?.dispose(); this.rallyMarker = null; this.rallyBuilding = null;
    this.targetMode = false; for (const entry of this.projectiles.values()) entry.mesh.dispose(); this.projectiles.clear(); for (const entry of this.effects.values()) entry.mesh.dispose(); this.effects.clear(); this.seenEffects.clear();
    for(const marker of this.impactWarnings?.values()??[])marker.dispose();this.impactWarnings?.clear();
    for (const root of this.pingMeshes.values()) root.dispose(); this.pingMeshes.clear();
    this.preview.setEnabled(true); this.camera.target.set(27, 0, 29); this.camera.radius = 47; this.camera.upperRadiusLimit = 90;
  }

  private makeResource(entity: ViewEntity): TransformNode {
    return this.createArt(entity.typeId, entity.xMm / 1000, entity.zMm / 1000, '#a5b68a');
  }

  private refreshHover(): void {
    const pointer = this.pointerEdge;
    if (!this.view || !pointer || !this.selected.length && !this.targetMode || this.pointerStart || this.placement || this.rallyBuilding || suppressGameplayHotkeys(document.activeElement)) {
      this.canvas.style.cursor = this.onHover(null); return;
    }
    let target = this.pick(pointer.x, pointer.y);
    if (this.targetMode && this.wallTargetType && !target?.id) target = this.pickWallVolume(pointer.x, pointer.y, target) ?? target;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.style.cursor = this.onHover(target ? { target, x: rect.left + pointer.x, y: rect.top + pointer.y } : null);
  }
  private releaseProjectile(mesh: TransformNode): void {
    const asset=this.assets.instances.get(mesh);mesh.setEnabled(false);
    if(asset && this.projectilePool.length<64)this.projectilePool.push(asset);else mesh.dispose();
  }

  private updateCombatVisuals(view: PlayerView, resetInterpolation = false): void {
    const visible = new Set(view.fog.visible), columns = Math.ceil(view.map.widthMm / view.map.fogCellMm), canSee = (xMm: number, zMm: number) => visible.has(Math.floor(zMm / view.map.fogCellMm) * columns + Math.floor(xMm / view.map.fogCellMm));
    const live = new Set((view.projectiles ?? []).filter((entry) => canSee(entry.xMm, entry.zMm)).map((entry) => entry.id));
    const warnings=this.impactWarnings??=new Map<string,Mesh>(),warningIds=new Set<string>();
    for(const projectile of view.projectiles??[]){const warning=projectile.impactWarning;if(!live.has(projectile.id)||!warning||warning.hitTick<=view.tick||!canSee(warning.xMm,warning.zMm))continue;warningIds.add(projectile.id);let marker=warnings.get(projectile.id);if(!marker){marker=MeshBuilder.CreateTorus('visible-siege-impact',{diameter:2,thickness:.045,tessellation:48},this.scene);marker.isPickable=false;marker.material=this.material('siege-impact-warning','#df9867');warnings.set(projectile.id,marker);}marker.scaling.set(warning.radiusMm/1000,1,warning.radiusMm/1000);marker.position.set(warning.xMm/1000,this.elevation(warning.xMm,warning.zMm)+.15,warning.zMm/1000);}
    for(const [id,marker] of warnings)if(!warningIds.has(id)){marker.dispose();warnings.delete(id);}
    for (const [id, effect] of this.effects) if (!canSee(effect.mesh.position.x * 1000, effect.mesh.position.z * 1000)) { effect.mesh.dispose(); this.effects.delete(id); }
    for (const [id, entry] of this.projectiles) if (!live.has(id)) { this.releaseProjectile(entry.mesh); this.projectiles.delete(id); }
    for (const projectile of view.projectiles ?? []) {
      if (!live.has(projectile.id)) continue;
      let entry = this.projectiles.get(projectile.id); const position = new Vector3(projectile.xMm / 1000, projectile.yMm / 1000, projectile.zMm / 1000);
      if (!entry) {
        const type=projectile.kind==='arrow'?'arrow':'catapult_stone',pooled=this.projectilePool.findIndex(asset=>asset.asset.id===type);
        const asset=pooled<0?this.assets.create(type):this.projectilePool.splice(pooled,1)[0]!;asset.pickable=false;
        const mesh = asset.root; mesh.scaling.setAll(projectile.sourceTypeId==='worldbreaker_trebuchet'?3:projectile.sourceTypeId==='warwolf_trebuchet'?2:projectile.sourceTypeId==='rune_catapult'?1.6:projectile.sourceTypeId==='wardbreaker_ballista'?2:1);mesh.setEnabled(true);mesh.rotation.setAll(0);mesh.position.copyFrom(position); entry = { mesh, from: position.clone(), to: position.clone(), received: performance.now(), motion: new MotionTrack() }; this.projectiles.set(projectile.id, entry);
      }
      entry.from.copyFrom(entry.to); entry.to.copyFrom(position); entry.received = performance.now(); entry.motion.setPublicationInterval(view.publicationIntervalMs);
      const committedMs = view.committedTimeMs ?? view.tick * 1000 / balance.rules.simulationHz;
      if (this.coarsePresentation()) entry.motion.pushTrace(position, committedMs, entry.received, projectile.motionTrace?.points.every(point => point.yMm !== undefined) ? { complete: projectile.motionTrace.complete, points: projectile.motionTrace.points.map(point => ({ time: point.tick * 1000 / balance.rules.simulationHz, x: point.xMm / 1000, y: point.yMm! / 1000, z: point.zMm / 1000 })) } : undefined, resetInterpolation);
      else entry.motion.push(position, committedMs, entry.received, resetInterpolation);
      if (resetInterpolation) entry.mesh.position.copyFrom(position); if (view.status !== 'RUNNING') entry.motion.freeze(entry.mesh.position); if (Vector3.DistanceSquared(entry.from, entry.to) > 0.001) entry.mesh.lookAt(entry.to.add(entry.to.subtract(entry.from)));
    }
    for (const effect of view.effects ?? []) {
      if (this.seenEffects.has(effect.id)) continue; this.seenEffects.add(effect.id);
      if (view.tick - effect.tick > balance.rules.simulationHz * 2 || !canSee(effect.xMm, effect.zMm)) continue;
      const effectLimit={low:16,medium:32,high:64}[this.preferences?.quality??'high'];if(this.effects.size>=effectLimit)continue;
      if (effect.kind === 'hit' && effect.entityId) { const target = this.rendered.get(effect.entityId); if (target) target.hitTick = effect.tick; }
      const death = effect.kind === 'death', type = death && effect.typeId && this.assets.bundle.assets[effect.typeId] ? effect.typeId : effect.kind === 'impact' ? 'dust' : 'smoke';
      const owner = view.players.find(player => player.id === effect.ownerId);
      const asset = this.assets.create(type, { age: effect.visualAge ?? 1, tier: effect.visualTier ?? 'base', color: owner?.color, pattern: owner?.pattern }); asset.pickable = false;
      asset.root.name = `visible-${effect.kind}`; asset.root.position.set(effect.xMm / 1000, this.elevation(effect.xMm, effect.zMm) + .05, effect.zMm / 1000); asset.root.rotation.y = (effect.rotation ?? 0) * Math.PI / 180;
      if(effect.kind==='impact')asset.root.scaling.setAll(effect.typeId==='worldbreaker_trebuchet'?3:effect.typeId==='rune_catapult'?1.8:1);
      let wave:{mesh:Mesh;radius:number}|undefined;
      if(effect.kind==='impact'&&effect.typeId==='rune_catapult'){const mesh=MeshBuilder.CreateTorus('visible-rune-shockwave',{diameter:2,thickness:.06,tessellation:32},this.scene);mesh.parent=asset.root;mesh.position.y=.08;mesh.isPickable=false;mesh.material=this.material('rune-shockwave','#9fbcad');wave={mesh,radius:Math.max(...units.rune_catapult!.areaDamageBands!.map(band=>band.radiusM))};}
      this.effects.set(effect.id, { mesh: asset.root, asset, tick: effect.tick, duration: death ? Math.max(2,asset.asset.clips.find(clip=>clip.id==='death')?.durationSeconds??2) : .65, death,...(wave?{wave}:{}) });

    }
    while (this.seenEffects.size > 2000) this.seenEffects.delete(this.seenEffects.values().next().value!);
  }

  private updateFog(view: PlayerView): void {
    const signature = `${view.fog.visible.join(',')}|${view.fog.explored.join(',')}`;
    if (signature === this.lastFog) return; this.lastFog = signature;
    this.fogMesh?.dispose();
    const size = view.map.fogCellMm / 1000, columns = Math.ceil(view.map.widthMm / view.map.fogCellMm), rows = Math.ceil(view.map.heightMm / view.map.fogCellMm);
    const visible = new Set(view.fog.visible), explored = new Set(view.fog.explored);
    const positions: number[] = [], indices: number[] = [], colors: number[] = [], normals: number[] = [];
    for (let z = 0; z < rows; z++) for (let x = 0; x < columns;) {
      const id = z * columns + x; if (visible.has(id)) { x++; continue; }
      const alpha = explored.has(id) ? 0.65 : 1, start = positions.length / 3, begin = x;
      const height = (cellX: number, cellZ: number) => Math.max(0, terrainHeightAt(this.groundTerrain, cellX * size * 1000, cellZ * size * 1000) / 1000) + 0.08;
      const beginTop = height(x, z), beginBottom = height(x, z + 1);
      // Flat runs share a quad; slopes keep their per-cell elevation and remain covered.
      x++;
      while (x < columns && !visible.has(z * columns + x) && (explored.has(z * columns + x) ? 0.65 : 1) === alpha && height(x, z) === beginTop && height(x, z + 1) === beginBottom && height(x + 1, z) === beginTop && height(x + 1, z + 1) === beginBottom) x++;
      positions.push(begin * size, beginTop, z * size, x * size, height(x, z), z * size, x * size, height(x, z + 1), (z + 1) * size, begin * size, beginBottom, (z + 1) * size);
      // Use the same diagonal as the ground, so the mask cannot slice through
      // non-planar cliff/ramp quads and produce alternating visible stripes.
      indices.push(start, start + 1, start + 3, start + 1, start + 2, start + 3);
      for (let i = 0; i < 4; i++) { colors.push(0.07, 0.12, 0.12, alpha); normals.push(0, 1, 0); }
    }
    for (const face of this.ridgeFaces) {
      if (visible.has(face.fogCell)) continue;
      // Ridge geometry is public and permanently impassable. Keep its rocky
      // silhouette readable even where cliff LOS never reveals an interior cell.
      // Ordinary ground fog remains opaque; no resource/entity visibility changes.
      const start = positions.length / 3, alpha = explored.has(face.fogCell) ? .25 : .45;
      for (let i = 0; i < 4; i++) {
        positions.push(face.positions[i * 3]!, face.positions[i * 3 + 1]! + .08, face.positions[i * 3 + 2]!);
        colors.push(.07, .12, .12, alpha); normals.push(0, 1, 0);
      }
      indices.push(start, start + 1, start + 3, start + 1, start + 2, start + 3);
    }
    const mesh = new Mesh('fog-of-war', this.scene); const vertexData = new VertexData();
    vertexData.positions = positions; vertexData.indices = indices; vertexData.colors = colors; vertexData.normals = normals; vertexData.applyToMesh(mesh);
    const material = this.material('fog', '#ffffff'); material.disableLighting = true; material.emissiveColor = Color3.White(); material.backFaceCulling = false; material.transparencyMode = StandardMaterial.MATERIAL_ALPHABLEND; material.zOffset = -1;
    mesh.material = material; mesh.hasVertexAlpha = true; mesh.isPickable = false; this.fogMesh = mesh;
  }

  select(ids: string[]): void {
    // Control-group recall must not reselect an exhausted historical node.
    this.selected = ids.filter(id => this.rendered.has(id)).slice(0, 200);
    for (const [id, entry] of this.rendered) entry.ring.setEnabled(entry.root.isEnabled() && this.selected.includes(id));
    this.updateSelectionIndicators();
    this.onSelection(this.selected);
    this.updateRallyMarker();
  }

  /** Bounded selected-entity overlays use only the recipient-authorized view. */
  private updateSelectionIndicators():void {
    const marks=this.selectionIndicators??=new Map<string,Mesh>(),wanted=new Set<string>();
    const entity=this.view?.entities.find(item=>item.id===this.selected[0]&&!item.ghost&&!item.garrisonedIn);
    const circle=(key:string,x:number,z:number,radius:number,color:string)=>{if(radius<=0)return;wanted.add(key);let mesh=marks.get(key);if(!mesh){mesh=MeshBuilder.CreateTorus('selected-'+key,{diameter:2,thickness:.018,tessellation:48},this.scene);mesh.isPickable=false;mesh.material=this.material('range-'+color,color);marks.set(key,mesh);}mesh.scaling.set(radius,1,radius);mesh.position.set(x/1000,this.elevation(x,z)+.17,z/1000);};
    if(entity){const unit=units[entity.typeId];if(unit?.projectileSpeedMps){circle('maximum',entity.xMm,entity.zMm,unit.rangeM+unit.collisionRadiusM,'#deca8a');circle('minimum',entity.xMm,entity.zMm,unit.minRangeM+unit.collisionRadiusM,'#be8063');}
      if(entity.typeId==='ward_spire'&&entity.ownerId===this.view!.playerId){circle('support',entity.xMm,entity.zMm,legendaryExpansion.wards.radiusM,'#8cbba6');for(const target of this.view!.entities.filter(item=>item.ownerId===this.view!.playerId&&item.ward?.supportId===entity.id).slice(0,6))circle(target.id,target.xMm,target.zMm,Math.max(...(buildings[target.typeId]?.footprintCells??[1,1])),'#8cbba6');}
    }
    for(const [key,mesh]of marks)if(!wanted.has(key)){mesh.dispose();marks.delete(key);}
    // Fade upper fortress geometry while a nearby ground actor is selected.
    // Selecting the building itself must retain its opaque roof and picking
    // surface; the cutaway is only an aid for a selected nearby ground unit.
    // This leaves the stable root and all simulation/collision state intact.
    for(const entry of this.rendered.values())if(entry.entity.kind==='building'&&entry.asset.asset.bounds.max[1]>12){const fade=entity?.kind==='unit'&&Math.hypot(entry.entity.xMm-entity.xMm,entry.entity.zMm-entity.zMm)<30000;if(entry.asset.appearance.roofFade!==fade)this.assets.update(entry.asset,{roofFade:fade});}
  }

  focus(xMm: number, zMm: number): void { this.camera.target.set(xMm / 1000, this.elevation(xMm, zMm), zMm / 1000); }

  setRallyMode(buildingId: string | null): void { this.rallyBuilding = buildingId; }
  setTargetMode(enabled: boolean, wallType: BuildingId | null = null): void { this.targetMode = enabled; this.wallTargetType = enabled ? wallType : null; }

  /** Replacement targets the wall's logical volume, including gaps between its stakes. */
  private pickWallVolume(x: number, y: number, terrain: WorldTarget | null): WorldTarget | null {
    if (!this.view || !this.wallTargetType) return null;
    const ray = this.scene.createPickingRay(x, y, Matrix.Identity(), this.camera);
    let distance = terrain ? Vector3.Distance(ray.origin, new Vector3(terrain.xMm / 1000, this.elevation(terrain.xMm, terrain.zMm), terrain.zMm / 1000)) : Infinity;
    let result: WorldTarget | null = null;
    for (const entity of this.view.entities) {
      if (entity.ownerId !== this.view.playerId || entity.typeId !== this.wallTargetType || entity.ghost || (entity.progress ?? 0) < 1) continue;
      const half = balance.rules.buildingGridM / 2, elevation = this.elevation(entity.xMm, entity.zMm);
      const low = new Vector3(entity.xMm / 1000 - half, elevation, entity.zMm / 1000 - half), high = new Vector3(entity.xMm / 1000 + half, elevation + 3, entity.zMm / 1000 + half);
      let near = 0, far = distance;
      for (const axis of ['x', 'y', 'z'] as const) {
        const direction = ray.direction[axis], origin = ray.origin[axis];
        if (Math.abs(direction) < 1e-8) { if (origin < low[axis] || origin > high[axis]) { far = -1; break; } continue; }
        const a = (low[axis] - origin) / direction, b = (high[axis] - origin) / direction;
        near = Math.max(near, Math.min(a, b)); far = Math.min(far, Math.max(a, b));
      }
      if (near <= far && near < distance) { distance = near; result = { id: entity.id, xMm: entity.xMm, zMm: entity.zMm }; }
    }
    return result;
  }

  private isWallPlacement(): boolean { return !!this.placement?.endsWith('_wall'); }
  private cell(point: WorldTarget): Cell { const size = balance.rules.buildingGridM * 1000; return { x: Math.floor(point.xMm / size), z: Math.floor(point.zMm / size) }; }

  private updateWall(target: WorldTarget | null, zFirst: boolean): void {
    if (!target || !this.view || !this.isWallPlacement()) return;
    this.placementTarget = target; this.wallZFirst = zFirst;
    const end = this.cell(target), begin = this.wallStart ?? end, cells: Cell[] = [{ ...begin }], cursor = { ...begin };
    for (const axis of zFirst ? ['z', 'x'] as const : ['x', 'z'] as const) while (cursor[axis] !== end[axis]) { cursor[axis] += Math.sign(end[axis] - cursor[axis]); cells.push({ ...cursor }); }
    this.wallCells = cells;
    const size = balance.rules.buildingGridM * 1000, fog = this.view.map.fogCellMm, columns = Math.ceil(this.view.map.widthMm / fog), visible = new Set(this.view.fog.visible), explored = new Set(this.view.fog.explored), definition = buildings[this.placement!]!;
    let invalid = 0, reused = 0, deferred = 0;
    const flags = cells.slice(0, 65).map((cell, index) => {
      const xMm = (cell.x + 0.5) * size, zMm = (cell.z + 0.5) * size;
      const endpoint = index === 0 || index === cells.length - 1;
      const existing = this.view!.entities.find((entity) => entity.xMm === xMm && entity.zMm === zMm && entity.typeId === this.placement && entity.ownerId === this.view!.playerId);
      if (endpoint && existing) { reused++; return { cell, valid: true, reused: true }; }
      let valid = cell.x >= 0 && cell.z >= 0 && (cell.x + 1) * size <= this.view!.map.widthMm && (cell.z + 1) * size <= this.view!.map.heightMm && placementAreaDiscovered({ xMm: cell.x * size, zMm: cell.z * size, widthMm: size, depthMm: size }, this.view!.map.widthMm, this.view!.map.heightMm, fog, balance.rules.treeBuildingClearanceM * 1000, (px, pz) => explored.has(Math.floor(pz / fog) * columns + Math.floor(px / fog)), this.view!.map.terrain ?? []) && terrainBuildable(this.view!.map.terrain ?? [], { xMm: cell.x * size, zMm: cell.z * size, widthMm: size, depthMm: size });
      for (const entity of this.view!.entities) {
        if (entity.ghost && entity.kind === 'unit' || entity.garrisonedIn || entity.kind === 'resource' && entity.amount === 0) continue;
        const radius = entity.kind === 'unit' ? (units[entity.typeId]?.collisionRadiusM ?? .4) * 1000 : resourcePlacementBounds(entity, balance.rules.treeBuildingClearanceM * 1000).halfWidth;
        const dimensions = entity.kind === 'building' ? [...(buildings[entity.typeId]?.footprintCells ?? [1, 1])].map((extent) => extent * size / 2) : [radius, radius];
        if ((entity.rotation ?? 0) % 180) dimensions.reverse();
        if (Math.abs(entity.xMm - xMm) < size / 2 + dimensions[0]! && Math.abs(entity.zMm - zMm) < size / 2 + dimensions[1]!) valid = false;
      }
      if (!valid) invalid++;
      else if (!placementAreaDiscovered({ xMm: cell.x * size, zMm: cell.z * size, widthMm: size, depthMm: size }, this.view!.map.widthMm, this.view!.map.heightMm, fog, balance.rules.treeBuildingClearanceM * 1000, (px, pz) => visible.has(Math.floor(pz / fog) * columns + Math.floor(px / fog)), this.view!.map.terrain ?? [])) deferred++;
      return { cell, valid, reused: false };
    });
    while (this.wallPreview.length < flags.length) { const mesh = MeshBuilder.CreateBox('wall-preview-segment', { width: size / 1000 - 0.04, depth: size / 1000 - 0.04, height: 0.5 }, this.scene); mesh.isPickable = false; this.wallPreview.push(mesh); }
    flags.forEach(({ cell, valid, reused: existing }, index) => { const mesh = this.wallPreview[index]!; mesh.setEnabled(true); mesh.position.set((cell.x + 0.5) * size / 1000, this.elevation((cell.x + 0.5) * size, (cell.z + 0.5) * size) + 0.28, (cell.z + 0.5) * size / 1000); const material = this.material(existing ? 'reused-wall' : valid ? 'valid-wall' : 'invalid-wall', existing ? '#84bec7' : valid ? '#abc892' : '#d9795a'); material.alpha = 0.6; mesh.material = material; });
    for (let index = flags.length; index < this.wallPreview.length; index++) this.wallPreview[index]!.setEnabled(false);
    const count = cells.length - reused, cost = balance.resourceOrder.filter((resource) => definition.cost[resource]).map((resource) => `${count * definition.cost[resource]} ${resource}`).join(', '), short = balance.resourceOrder.some((resource) => count * definition.cost[resource] > this.view!.self.resources[resource]);
    const status = cells.length > 64 ? 'Maximum 64 cells per drag' : invalid ? `${invalid} obstructed or unexplored cells` : short ? 'Insufficient resources' : deferred ? 'Explored wall path; builders will verify each planned site' : 'Clear visible wall path';
    this.onPlacementHint(`${status} · ${count} new, ${reused} reused endpoints · ${cost} · (${begin.x},${begin.z}) → (${end.x},${end.z}) · ${Math.floor(Math.max(Math.abs(end.x - begin.x), Math.abs(end.z - begin.z)) / 3)} potential gate spans`);
  }

  private updateRallyMarker(): void {
    const producer = this.view?.entities.find((entity) => this.selected.includes(entity.id) && entity.ownerId === this.view?.playerId && entity.rally);
    if (!producer?.rally) { this.rallyMarker?.setEnabled(false); return; }
    if (!this.rallyMarker) {
      this.rallyMarker = new TransformNode('rally-point', this.scene);
      this.part(MeshBuilder.CreateCylinder('rally-pole', { diameter: 0.1, height: 2.5, tessellation: 5 }, this.scene), this.rallyMarker, this.material('timber', '#524c3c'), 0, 1.25, 0);
      this.part(MeshBuilder.CreateBox('rally-flag', { width: 1, height: 0.6, depth: 0.05 }, this.scene), this.rallyMarker, this.material('selection', '#ebd69e'), 0.5, 2.1, 0);
      for (const mesh of this.rallyMarker.getChildMeshes()) mesh.isPickable = false;
    }
    this.rallyMarker.setEnabled(true); this.rallyMarker.position.set(producer.rally.xMm / 1000, this.elevation(producer.rally.xMm, producer.rally.zMm), producer.rally.zMm / 1000);
  }

  screenPosition(id: string): { x: number; y: number } | null {
    const root = this.rendered.get(id)?.root; if (!root) return null;
    const position = Vector3.Project(root.position.add(new Vector3(0, 1, 0)), Matrix.Identity(), this.scene.getTransformMatrix(), this.camera.viewport.toGlobal(this.engine.getRenderWidth(), this.engine.getRenderHeight()));
    return { x: position.x * this.canvas.clientWidth / this.engine.getRenderWidth(), y: position.y * this.canvas.clientHeight / this.engine.getRenderHeight() };
  }

  pick(x: number, y: number, terrainOnly = false): WorldTarget | null {
    const hit = this.scene.pick(x, y, (mesh) => mesh.isEnabled() && mesh.isVisible && mesh.isPickable && (!terrainOnly && !!mesh.metadata?.entityId || mesh === this.ground || !!mesh.metadata?.terrain));
    if (!this.view) return null;
    const ray = this.scene.createPickingRay(x, y, Matrix.Identity(), this.camera);
    let distance = hit?.pickedPoint ? Vector3.Distance(ray.origin, hit.pickedPoint) : Infinity, selected: RenderEntity | undefined;
    if (!terrainOnly) for (const entry of this.rendered.values()) {
      if (!entry.root.isEnabled() || entry.entity.garrisonedIn) continue;
      const inverse = entry.root.computeWorldMatrix(true).clone().invert(), origin = Vector3.TransformCoordinates(ray.origin,inverse), direction = Vector3.TransformNormal(ray.direction,inverse);
      const halfWall = balance.rules.buildingGridM / 2;
      const bounds = entry.entity.typeId.endsWith('_wall') ? { min: [-halfWall, 0, -halfWall], max: [halfWall, 3, halfWall] } : entry.asset.asset.bounds;
      let near = 0, far = distance;
      for (const [index,axis] of (['x','y','z'] as const).entries()) {
        if (Math.abs(direction[axis]) < 1e-8) { if (origin[axis] < bounds.min[index]! || origin[axis] > bounds.max[index]!) { far = -1; break; } continue; }
        const a=(bounds.min[index]!-origin[axis])/direction[axis],b=(bounds.max[index]!-origin[axis])/direction[axis];near=Math.max(near,Math.min(a,b));far=Math.min(far,Math.max(a,b));
      }
      if (near <= far && near < distance) {
        // Wall gaps intentionally retain their logical selection volume. Other
        // buildings must actually occupy the ray in their observed age/state.
        const actual = entry.entity.kind === 'building' && !entry.entity.typeId.endsWith('_wall') ? this.assets.pickDistance(entry.asset, ray, distance) : near;
        if (actual !== null && actual < distance) { distance = actual; selected = entry; }
      }
    }
    if (selected) return { id: selected.id, xMm: selected.entity.xMm, zMm: selected.entity.zMm };
    if (!hit?.pickedPoint) return null;
    return { xMm: Math.max(0, Math.min(this.view.map.widthMm - 1, Math.round(hit.pickedPoint.x * 1000))), zMm: Math.max(0, Math.min(this.view.map.heightMm - 1, Math.round(hit.pickedPoint.z * 1000))) };
  }

  setPlacement(type: BuildingId | null): void {
    this.placement = type; this.placementRotation = 0; this.placementTarget = null; this.previewMesh?.dispose(); this.previewMesh = null; this.wallStart = null; this.wallZFirst = false; this.wallCells = [];
    for (const mesh of this.wallPreview) mesh.dispose(); this.wallPreview = [];
    if (!type) return;
    if (this.isWallPlacement()) { this.onPlacementHint('Drag up to 64 cells. Hold Ctrl to change bend direction. Owned endpoints are reused.'); return; }
    this.previewMesh = this.makeBuilding(type, this.camera.target.x, this.camera.target.z, '#d9cd96');
    const asset = this.assets.instances.get(this.previewMesh)!; asset.pickable = false; this.assets.update(asset, { age: this.view?.self.age ?? 1, opacity: .45 });
    const definition = buildings[type]!;
    const footprint = MeshBuilder.CreateGround('placement-footprint', { width: definition.footprintCells[0] * balance.rules.buildingGridM, height: definition.footprintCells[1] * balance.rules.buildingGridM }, this.scene);
    footprint.parent = this.previewMesh; footprint.position.y = 0.06; footprint.isPickable = false;
    for (const mesh of this.previewMesh.getChildMeshes()) { mesh.visibility = 0.45; mesh.isPickable = false; }
    this.onPlacementHint(definition.defaultGateMode ? 'Click the center of a gap or completed matching wall run. Gates align to nearby walls; rotation keys work on open ground.' : 'Choose a clear, explored site. Builders verify sites beyond current vision.');
  }

  rotatePlacement(degrees: number): void { this.placementRotation = ((this.placementRotation + degrees + 360) % 360) as Rotation; this.updatePlacement(this.placementTarget); }

  /** Re-resolve on click against the latest view; never send a stale preview span. */
  placementCommand(target: WorldTarget, builderIds: string[], queued: boolean): GameplayCommand | null {
    if (!this.placement || !this.view) return null;
    const placement = resolveBuildingPlacement(this.view, this.placement, target, this.placementRotation);
    this.placementRotation = placement.rotation;
    if (placement.reason) this.onPlacementHint(placement.reason);
    return buildingPlacementCommand(this.placement, placement, builderIds, queued);
  }

  private updatePlacement(target: WorldTarget | null): void {
    if (!target || !this.placement || !this.previewMesh || !this.view) return;
    this.placementTarget = target;
    const definition = buildings[this.placement]!; const gridMm = balance.rules.buildingGridM * 1000;
    const placement = resolveBuildingPlacement(this.view, this.placement, target, this.placementRotation);
    this.placementRotation = placement.rotation;
    const { x, z } = placement.originCell;
    const [width, depth] = this.placementRotation % 180 ? [...definition.footprintCells].reverse() : definition.footprintCells;
    const centerX = (x + width! / 2) * gridMm, centerZ = (z + depth! / 2) * gridMm;
    this.previewMesh.position.set(centerX / 1000, this.elevation(centerX, centerZ) + 0.1, centerZ / 1000); this.previewMesh.rotation.y = this.placementRotation * Math.PI / 180;
    const visible = new Set(this.view.fog.visible), explored = new Set(this.view.fog.explored), columns = Math.ceil(this.view.map.widthMm / this.view.map.fogCellMm);
    const footprint = { xMm: x * gridMm, zMm: z * gridMm, widthMm: width! * gridMm, depthMm: depth! * gridMm };
    const discovered = (cells:Set<number>) => placementAreaDiscovered(footprint, this.view!.map.widthMm, this.view!.map.heightMm, this.view!.map.fogCellMm, balance.rules.treeBuildingClearanceM * 1000, (px, pz) => cells.has(Math.floor(pz / this.view!.map.fogCellMm) * columns + Math.floor(px / this.view!.map.fogCellMm)), this.view!.map.terrain ?? []);
    let reason = x < 0 || z < 0 || (x + width!) * gridMm > this.view.map.widthMm || (z + depth!) * gridMm > this.view.map.heightMm ? 'Outside map boundary' : placement.reason ?? '';
    if (!discovered(explored)) reason = 'Site and resource clearance must be explored';
    if (!terrainBuildable(this.view.map.terrain ?? [], { xMm: x * gridMm, zMm: z * gridMm, widthMm: width! * gridMm, depthMm: depth! * gridMm })) reason = 'Water, crossing, or slope blocks this site';
    let valid = !reason;
    if (valid) for (const entity of this.view.entities) {
      if (placement.wallIds.includes(entity.id) || entity.ghost && entity.kind === 'unit' || entity.garrisonedIn || entity.kind === 'resource' && entity.amount === 0) continue;
      const radius = entity.kind === 'unit' ? (units[entity.typeId]?.collisionRadiusM ?? .4) * 1000 : resourcePlacementBounds(entity, balance.rules.treeBuildingClearanceM * 1000).halfWidth;
      const extents = entity.kind === 'building' ? buildings[entity.typeId]?.footprintCells.map((n) => n * gridMm / 2) ?? [gridMm / 2, gridMm / 2] : [radius, radius];
      if (entity.rotation && entity.rotation % 180) extents.reverse();
      if (Math.abs(entity.xMm - centerX) < width! * gridMm / 2 + extents[0]! && Math.abs(entity.zMm - centerZ) < depth! * gridMm / 2 + extents[1]!) { valid = false; reason = 'A unit, structure, or resource obstructs this site'; }
    }
    this.onPlacementHint(valid ? `${placement.wallIds.length ? `Replace ${placement.wallIds.length} completed walls at full gate cost` : discovered(visible) ? 'Clear visible site' : 'Explored site; builder will verify before construction'}${placement.aligned ? ' · aligned to wall' : ''} — ${this.placementRotation}° — click to request construction.` : `× ${reason} · ${this.placementRotation}°`);
    const asset = this.assets.instances.get(this.previewMesh); if (asset) this.assets.update(asset, { opacity: valid ? .55 : .2 });
    for (const mesh of this.previewMesh.getChildMeshes()) {
      mesh.visibility = valid ? 0.55 : 0.2;
      if (mesh.name === 'placement-footprint') { const material = this.material(valid ? 'valid-placement' : 'invalid-placement', valid ? '#a7d49e' : '#e28265'); material.disableLighting = true; material.emissiveColor = material.diffuseColor; material.alpha = 0.6; mesh.material = material; mesh.visibility = 1; }
    }
  }

  makeTree(x: number, z: number, parent?: TransformNode, variation = 0, type = 'tree_oak'): TransformNode {
    const root = this.createArt(type, x, z, '#a5b68a', parent); root.rotation.y = variation * 2.399; return root;
  }
  makeUnit(type: string, x: number, z: number, color: string, parent?: TransformNode): TransformNode { return this.createArt(type, x, z, color, parent); }

  dispose(): void {
    browserResponseProbe.observe(probe=>probe.boundary('renderer-disposed'));
    this.disposed = true; this.assetAbort.abort(); this.assets?.dispose();
    this.canvas.removeEventListener('pointerleave', this.pointerLeave); window.removeEventListener('blur', this.blur); window.removeEventListener('focusin', this.focusIn);
    window.removeEventListener('resize', this.resize);
    window.removeEventListener('keydown', this.keyDown);
    window.removeEventListener('keyup', this.keyUp);
    this.canvas.removeEventListener('webglcontextlost', this.contextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.contextRestored);
    this.canvas.removeEventListener('pointerdown', this.pointerDown);
    this.canvas.removeEventListener('pointerup', this.pointerUp);
    this.canvas.removeEventListener('pointermove', this.pointerMove);
    this.canvas.removeEventListener('dblclick', this.doubleClick);
    this.canvas.removeEventListener('contextmenu', this.contextMenu);
    this.scene.dispose();
    this.engine.dispose();
  }
}
