# ev-sim

This is our in-house simulation environment for testing and developing algorithms for autonomous driving. It is built on top of [three.js](https://threejs.org/) and provides a visual scripting interface for creating and running simulations.

## Quick Start

```bash
npm install
npm run dev
```

The app starts on the visual scripting canvas. Press `Escape` to switch between scripting and the 3D scene.

## Documentation

- [Documentation index](docs/README.md)
- [Getting started](docs/getting-started.md)
- [Architecture](docs/architecture.md)
- [Development workflow](docs/development.md)
- [Visual scripting](docs/scripting/README.md)
- [Simulation](docs/simulation.md)
- [ROS integration](docs/ros-integration.md)
- [Assets](docs/assets.md)
- [Troubleshooting](docs/troubleshooting.md)

## CommonRoad Scenarios

Download scenarios from `https://gitlab.lrz.de/tum-cps/commonroad-scenarios` and place the `scenarios` folder in `public/`, creating `public/scenarios`.

Example browser path:

```text
/scenarios/DR_CHN_Merging_ZS_1_T_1.xml
```

See [Assets](docs/assets.md) for asset policy and setup details.

## References

[M. Althoff, M. Koschi, and S. Manzinger, "CommonRoad: Composable Benchmarks for Motion Planning on Roads," in Proc. of the IEEE Intelligent Vehicles Symposium, 2017, pp. 719-726.](http://mediatum.ub.tum.de/doc/1379638/776321.pdf)