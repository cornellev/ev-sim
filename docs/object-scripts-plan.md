# Object scripts

Editor objects can carry a visual script. Run writes permanent groups, props, asset copies, and primitive copies into the environment document. Spawn Prop and Scatter Features stay on the episode overlay and do not do this.

Attachments live on the schema-v4 object graph, not on legacy feature records.

- `components.scripts`: `{ id, scriptId, parameters, seed }[]`
- `components.authoredBy`: `null` or `{ attachmentId, scriptId }`

Both keys are omitted when absent. They do not enter `worldHash`. Features, groups, asset instances, and primitives the script creates do.

## Packages

| Package | Status | What landed |
| --- | --- | --- |
| OSC-01 | done | Hierarchy **New Subgroup** on one selected group and **New Group** on empty hierarchy space. Both call `createObject({ typeId: "group", parentId })`. |
| OSC-02 | done | `attachScript`, `detachScript`, `setScriptParameters` in `scriptAttachmentCommands.js`. Inspector **Scripts** section. |
| OSC-03 | done | One attachment host per script. Placeable blocks: General, Road, Group, Building, Intersection, Prop, and Asset. Derive From Attachment stays loadable and is not placeable. |
| OSC-04 | done | Program type `scene_object`. Optional `sceneType` on program inputs filters the inspector picker. `sceneTypes` accepts more than one host type. An empty id is the root only when both are omitted. |
| OSC-05 | done | Place Feature and Create Group call `runtimeContext.author`. `runObjectScript` records ops. `applyObjectScript` replaces that attachment's output in one undo step. Bake clears `authoredBy`. Duplicate drops `authoredBy` and lifts a copy out of a generated group. Template: **Props along road**. |
| OSC-06 | done | MCP `environment_attach_script`, `environment_set_script_parameters`, `environment_run_object_script`. `environment_add_object` accepts `parentId`. |

## Run

The inspector Run button, and `environment_run_object_script`, load `latestValidArtifact` and call `runObjectScript`. The runner refuses a host mismatch, a missing required `scene_object`, and a failed script. On failure it discards ops, because `author` may already have recorded some.

`Object ID to Scene Object` calls `runtimeContext.findSceneObject`. That lookup hits `document.getObject`, and also ids this run has already authored. A miss emits an empty `scene_object` and `found:false`.

`applyObjectScript` then, in one `CommandBus` transaction:

1. Deletes objects whose `authoredBy.attachmentId` matches. `deleteObjects` removes the descendant closure. A locked owned object fails the whole transaction.
2. Creates each group, builtin prop, cloned asset instance, or cloned primitive.
3. Sets `authoredBy` on each created record.

Re-run replaces that attachment's output. It does not match by name. Bake (`clearAuthoredBy`) leaves the objects and the next Run adds a new set.

`script_lint` and `binding_create` add a warning only when the artifact contains Place Feature, Clone Object, or Create Group. Those scripts run from an object attachment, not from a simulation binding.

**Obstacles along road** attaches to a road. `obstacle` is a prop or an asset instance. `count` is the number of stations from the start of the road to the end. `clearance` is metres past the shoulder. Run creates an Obstacles group under `group` and clones the source on both outer edges. Copies use the road heading. Prop type, asset pin, and scale come from the source.

## Host fields

The inspector **Add Script** button lists library scripts whose host matches the selected object. The host is read from the editor graph when the script has one, and from `latestValidArtifact` otherwise.

| Block | Host | Fits | Fields |
| --- | --- | --- | --- |
| General Attachment | any selected object | every object, including skybox and tile | `objectId`, `name` |
| Road Attachment | road | roads | `edgeId: road_id` (the object id), `name` |
| Group Attachment | group | groups | `objectId`, `name` |
| Building Attachment | building | buildings | `buildingId`, `name` |
| Intersection Attachment | intersection | intersections | `nodeId`, `name` |
| Prop Attachment | builtin-prop | builtin props | `objectId`, `assetId` (legacy feature type), `name` |
| Asset Attachment | asset-instance | asset instances | `objectId`, `assetId` (`components.asset.assetId`), `name` |

Every block also emits `found: boolean`. A script with no attachment block fits any object, and so does a script whose only attachment block is General Attachment. Two different attachment hosts make the script invalid to attach. Derive From Attachment is the old dropdown form of the same fields. Old graphs still open it. New graphs use the named blocks.
