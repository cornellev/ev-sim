# Object scripts

Editor objects can carry a visual script. Run writes permanent groups and props into the environment document. Spawn Prop and Scatter Features stay on the episode overlay and do not do this.

Attachments live on the schema-v4 object graph, not on legacy feature records.

- `components.scripts`: `{ id, scriptId, parameters, seed }[]`
- `components.authoredBy`: `null` or `{ attachmentId, scriptId }`

Both keys are omitted when absent. They do not enter `worldHash`. Features and groups the script creates do.

## Packages

| Package | Status | What landed |
| --- | --- | --- |
| OSC-01 | done | Hierarchy **New Subgroup** on one selected group and **New Group** on empty hierarchy space. Both call `createObject({ typeId: "group", parentId })`. |
| OSC-02 | done | `attachScript`, `detachScript`, `setScriptParameters` in `scriptAttachmentCommands.js`. Inspector **Scripts** section. |
| OSC-03 | done | Derive From Attachment. One host type per script: road, group, building, intersection, builtin-prop, asset-instance. |
| OSC-04 | done | Program type `scene_object`. Optional `sceneType` on program inputs filters the inspector picker. An empty id is the root only when `sceneType` is omitted. |
| OSC-05 | done | Place Feature and Create Group call `runtimeContext.author`. `runObjectScript` records ops. `applyObjectScript` replaces that attachment's output in one undo step. Bake clears `authoredBy`. Duplicate drops `authoredBy` and lifts a copy out of a generated group. Template: **Props along road**. |
| OSC-06 | done | MCP `environment_attach_script`, `environment_set_script_parameters`, `environment_run_object_script`. `environment_add_object` accepts `parentId`. |

## Run

The inspector Run button, and `environment_run_object_script`, load `latestValidArtifact` and call `runObjectScript`. The runner refuses a host mismatch, a missing required `scene_object`, and a failed script. On failure it discards ops, because `author` may already have recorded some.

`applyObjectScript` then, in one `CommandBus` transaction:

1. Deletes objects whose `authoredBy.attachmentId` matches. `deleteObjects` removes the descendant closure. A locked owned object fails the whole transaction.
2. Creates each group or builtin prop.
3. Sets `authoredBy` on each created record.

Re-run replaces that attachment's output. It does not match by name. Bake (`clearAuthoredBy`) leaves the objects and the next Run adds a new set.

`script_lint` and `binding_create` add a warning only when the artifact contains Place Feature or Create Group. Those scripts run from an object attachment, not from a simulation binding.

## Host fields

| Host | Fields |
| --- | --- |
| road | `edgeId: road_id` (the object id), `name` |
| group | `objectId`, `name` |
| building | `buildingId`, `name` |
| intersection | `nodeId`, `name` |
| builtin-prop | `objectId`, `assetId` (legacy feature type), `name` |
| asset-instance | `objectId`, `assetId` (`components.asset.assetId`), `name` |

Every host also emits `found: boolean`. No derive block means the script can attach to any object. Two derive host types make the script invalid to attach.
