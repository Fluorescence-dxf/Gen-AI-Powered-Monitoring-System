# Contributing Guide

Thank you for wanting to contribute to **Gen‑AI‑Powered‑Monitoring‑System**!

## How to get started
1. **Fork** the repository on GitHub.
2. **Clone** your fork locally:
   ```bash
   git clone https://github.com/<your‑username>/Gen-AI-Powered-Monitoring-System.git
   cd Gen-AI-Powered-Monitoring-System
   ```
3. **Create a new branch** for your work:
   ```bash
   git checkout -b feature/your‑feature-name
   ```
4. Follow the **development workflow** below.

## Development workflow
| Step | Description |
|------|-------------|
| **Build firmware** | Install Arduino CLI (`arduino-cli`) and compile the firmware:
   ```bash
   arduino-cli core update-index
   arduino-cli core install esp32:esp32
   arduino-cli compile --fqbn esp32:esp32:esp32 ./Capstone/Firmware/Capstone.ino
   ``` |
| **Run local tests** | There are no automated unit tests yet, but you can manually verify the serverless script by opening `Capstone/Google Apps Script/Index.html` in a browser and ensuring the UI loads. |
| **Commit** | Write clear commit messages. Follow the pattern `type(scope): description` (e.g., `feat(dashboard): add humidity chart`). |
| **Push & PR** | Push your branch and open a Pull Request against `main`. Include a short description of the change and reference any related issue. |

## Pull‑request checklist
- [ ] Code follows the existing style (see existing files).
- [ ] All Markdown links are **relative**.
- [ ] No secret keys/API tokens are committed.
- [ ] CI passes (see GitHub Actions badge).
- [ ] Documentation (`README.md` or relevant docs) is updated if needed.

## Reporting bugs / requesting features
- Use the **GitHub Issue** templates provided in `.github/ISSUE_TEMPLATE/`.

---
*Happy hacking!*