# VSCODE Extension for Coding Behavior Logging
## How to run
1, Open this project in VSCode.<br>
2, Install node dependencies by running 
```
npm install
```
3, Run the extension by pressing F5.<br>
4, A new VSCode workspace will pop up with the extension running.<br>
5, Do some coding in the new workspace.<br>
6, Check the log locally. <br>
  - Local log path: {root-path-to-the-project-opened-in-pop-up-workspace}/log/editLog.json


Hidden Code Extension
This project explores a new way of handling debugging and instrumentation code. Instead of mixing debug logic into the main source files, developers can insert hidden overlays that are stored separately from the original source. These overlays can add, replace, or remove lines of code in a way that is visible in the editor (e.g., ghosted lines), but they never modify the canonical source files. At build time, developers choose between a clean build (no overlays) or an instrumented build (source + overlays merged). The goal is to keep the source codebase clean, avoid merge conflicts and code review noise, and still provide downstream developers with debug-capable builds.
