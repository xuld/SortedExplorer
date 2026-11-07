import * as vscode from "vscode"
import * as path from "path"
import * as os from "os"

const configSection = "sortedExplorer"
const emptyOrders = new Map<string, string[]>()

let cuttingItems: vscode.Uri[] | undefined
let copyingItems: vscode.Uri[] | undefined
let compareItem: vscode.Uri | undefined

export function activate(context: vscode.ExtensionContext) {
	// Create tree provider and watch for configuration changes and file system changes
	const treeProvider = new FileTreeProvider(vscode.workspace.workspaceFolders, getConfig())
	context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
		treeProvider.setWorkspaceFolders(vscode.workspace.workspaceFolders)
		updateTitle()
	}))
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration(configSection)) {
			treeProvider.setConfig(getConfig())
		}
	}))
	const fileWatcher = vscode.workspace.createFileSystemWatcher("**/*", false, true, false)
	fileWatcher.onDidCreate(() => treeProvider.refresh())
	fileWatcher.onDidDelete(() => treeProvider.refresh())
	context.subscriptions.push(fileWatcher)

	// Create tree view
	const treeView = vscode.window.createTreeView("sortedExplorer", {
		treeDataProvider: treeProvider,
		dragAndDropController: new DragDropController(treeProvider),
		canSelectMany: true
	})
	context.subscriptions.push(treeView, treeView.onDidChangeCheckboxState(async e => {
		const projects = new Set<ProjectConfig>()
		for (const [item, state] of e.items) {
			const project = treeProvider.getProject(item.resourceUri)
			if (!project) {
				continue
			}
			project.setState(getRelativePath(item.resourceUri), state === vscode.TreeItemCheckboxState.Checked)
			projects.add(project)
		}
		for (const project of projects) {
			await project.save()
		}
	}))
	updateTitle()

	// Sync orders & labels & states states when file renamed
	context.subscriptions.push(vscode.workspace.onDidRenameFiles(async e => {
		await handleRenameFiles(e.files)
	}))
	context.subscriptions.push(vscode.workspace.onDidDeleteFiles(async e => {
		await handleDeleteFiles(e.files)
	}))

	// Register cut decoration provider
	const cutDecorationProvider = new CutFileDecorationProvider()
	context.subscriptions.push(vscode.window.registerFileDecorationProvider(cutDecorationProvider))

	// Register commands
	context.subscriptions.push(
		vscode.commands.registerCommand("sortedExplorer.openFolder", async () => {
			const folderUris = await vscode.window.showOpenDialog({
				canSelectFiles: false,
				canSelectFolders: true,
				canSelectMany: true,
				openLabel: 'Open',
			})
			if (folderUris) {
				vscode.workspace.updateWorkspaceFolders(0, 0, ...folderUris.map(folderUri => ({ uri: folderUri })))
			}
		}),

		vscode.commands.registerCommand("sortedExplorer.newFile", async (item = treeView.selection[0]) => {
			const dir = item ? item.collapsibleState !== vscode.TreeItemCollapsibleState.None ? item.resourceUri : vscode.Uri.joinPath(item.resourceUri, "..") : vscode.workspace.workspaceFolders?.[0].uri
			if (!dir) {
				return
			}
			const openedDocument = vscode.window.activeTextEditor?.document
			const ext = openedDocument ? path.extname(openedDocument.uri.path) : ""
			const baseName = "untitled-1"
			const name = await vscode.window.showInputBox({
				prompt: vscode.l10n.t("Input file name"),
				value: baseName + ext,
				valueSelection: [0, baseName.length]
			})
			if (name) {
				const filePath = vscode.Uri.joinPath(dir, name)
				const edit = new vscode.WorkspaceEdit()
				edit.createFile(filePath)
				await vscode.workspace.applyEdit(edit)
				await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(filePath))
			}
		}),
		vscode.commands.registerCommand("sortedExplorer.newFolder", async (item = treeView.selection[0]) => {
			const dir = item ? item.collapsibleState !== vscode.TreeItemCollapsibleState.None ? item.resourceUri : vscode.Uri.joinPath(item.resourceUri, "..") : vscode.workspace.workspaceFolders?.[0].uri
			if (!dir) {
				return
			}
			const name = await vscode.window.showInputBox({ prompt: vscode.l10n.t("Input folder name"), value: "folder-1" })
			if (name) {
				const dirPath = vscode.Uri.joinPath(dir, name)
				await vscode.workspace.fs.createDirectory(dirPath)
			}
		}),
		vscode.commands.registerCommand("sortedExplorer.refresh", () => {
			treeProvider.refresh()
		}),
		vscode.commands.registerCommand("sortedExplorer.collapseAll", () => {
			vscode.commands.executeCommand("workbench.actions.treeView.sortedExplorer.collapseAll")
		}),

		vscode.commands.registerCommand("sortedExplorer.revealInExplorer", (item = treeView.selection[0]) => {
			if (!item) {
				return
			}
			vscode.commands.executeCommand("revealInExplorer", item.resourceUri)
		}),
		vscode.commands.registerCommand("sortedExplorer.revealFileInOS", (item = treeView.selection[0]) => {
			if (!item) {
				return
			}
			vscode.commands.executeCommand("revealFileInOS", item.resourceUri)
		}),
		vscode.commands.registerCommand("sortedExplorer.revealInFinder", (item = treeView.selection[0]) => {
			if (!item) {
				return
			}
			vscode.commands.executeCommand("revealFileInOS", item.resourceUri)
		}),
		vscode.commands.registerCommand("sortedExplorer.revealInWindowsExplorer", (item = treeView.selection[0]) => {
			if (!item) {
				return
			}
			vscode.commands.executeCommand("revealFileInOS", item.resourceUri)
		}),
		vscode.commands.registerCommand("sortedExplorer.revealInSortedExplorer", async (uri?: vscode.Uri) => {
			if (uri) {
				await treeView.reveal(treeProvider.getItemByPath(uri), {
					select: true,
					focus: true,
					expand: true
				})
				return
			}
			const activeEditor = vscode.window.activeTextEditor
			if (!activeEditor) {
				vscode.window.showInformationMessage(vscode.l10n.t("No active file"))
				return
			}
			await treeView.reveal(treeProvider.getItemByPath(activeEditor.document.uri), {
				select: true,
				focus: true,
				expand: true
			})
		}),
		vscode.commands.registerCommand("sortedExplorer.openInTerminal", (item: FileTreeItem = treeView.selection[0]) => {
			const dir = item ? item.collapsibleState !== vscode.TreeItemCollapsibleState.None ? item.resourceUri : vscode.Uri.joinPath(item.resourceUri, "..") : vscode.workspace.workspaceFolders?.[0].uri
			if (!dir) {
				return
			}
			vscode.window.createTerminal({ cwd: dir }).show()
		}),
		vscode.commands.registerCommand("sortedExplorer.openAllFiles", async (item: FileTreeItem = treeView.selection[0]) => {
			if (item instanceof vscode.Uri) item = { resourceUri: item } as any
			const dir = item ? item.collapsibleState !== vscode.TreeItemCollapsibleState.None ? item.resourceUri : vscode.Uri.joinPath(item.resourceUri, "..") : vscode.workspace.workspaceFolders?.[0].uri
			if (!dir) {
				return
			}
			const maxFilesWithoutConfirmation = 10
			let files = await vscode.workspace.findFiles(new vscode.RelativePattern(dir, "**/*"))
			if (files.length == 0) {
				vscode.window.showInformationMessage(vscode.l10n.t("No files found in folder."))
				return
			}
			if (maxFilesWithoutConfirmation >= 0 && files.length >= maxFilesWithoutConfirmation) {
				const pattern = await vscode.window.showInputBox({
					title: vscode.l10n.t("Are you sure you want to open {0} files at once?", files.length),
					prompt: vscode.l10n.t("Please input a glob to open"),
					placeHolder: vscode.l10n.t("For example: **/*.*,!*.test.*"),
					value: "**/*",
				})
				if (!pattern) {
					return
				}
				if (pattern !== "**/*") {
					let excludePattern = ""
					const includePattern = pattern.replace(/(?:^|,)!((?:\{[^}]*\}|\[[^\]]*\]|[^,])*)(?=,|$)/g, (source, pattern) => {
						if (excludePattern) {
							excludePattern += ","
						}
						excludePattern += pattern
						return ""
					})
					files = await vscode.workspace.findFiles(new vscode.RelativePattern(dir, includePattern), excludePattern ? new vscode.RelativePattern(dir, excludePattern) : undefined)
				}
			}

			files.sort((x, y) => x.fsPath < y.fsPath ? -1 : x.fsPath > y.fsPath ? 1 : 0)
			for (const file of files) {
				vscode.commands.executeCommand("vscode.open", file, {
					preview: false
				})
			}
		}),

		vscode.commands.registerCommand("sortedExplorer.openFile", async (uri: vscode.Uri, items?: FileTreeItem[]) => {
			if (items) {
				for (const item of items) {
					await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(item.resourceUri))
				}
			} else {
				await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri))
			}
		}),
		vscode.commands.registerCommand("sortedExplorer.openToSide", async (item = treeView.selection[0], items?: FileTreeItem[]) => {
			if (items) {
				for (const item of items) {
					await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(item.resourceUri), vscode.ViewColumn.Beside)
				}
				return
			}
			if (!item) {
				return
			}
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(item.resourceUri), vscode.ViewColumn.Beside)
		}),
		vscode.commands.registerCommand("sortedExplorer.openWith", async (item = treeView.selection[0], items?: FileTreeItem[]) => {
			if (items) {
				for (const item of items) {
					await vscode.commands.executeCommand("vscode.openWith", item.resourceUri, "default")
				}
				return
			}
			await vscode.commands.executeCommand("vscode.openWith", item.resourceUri, "default")
		}),

		vscode.commands.registerCommand("sortedExplorer.selectForCompare", async (item = treeView.selection[0]) => {
			if (!item) {
				return
			}
			compareItem = item.resourceUri
			await vscode.commands.executeCommand("setContext", "sortedExplorer.compare", true)
		}),
		vscode.commands.registerCommand("sortedExplorer.compareWithSelected", async (item = treeView.selection[0]) => {
			if (!item) {
				return
			}
			if (!compareItem) {
				vscode.window.showWarningMessage(vscode.l10n.t("Please select a file first to compare"))
				return
			}
			vscode.commands.executeCommand("vscode.diff", compareItem, item.resourceUri)
			compareItem = undefined
			await vscode.commands.executeCommand("setContext", "sortedExplorer.compare", undefined)
		}),

		vscode.commands.registerCommand("sortedExplorer.openTimeline", async (item = treeView.selection[0]) => {
			if (!item) {
				return
			}
			await vscode.commands.executeCommand("files.openTimeline", item.resourceUri)
		}),

		vscode.commands.registerCommand("sortedExplorer.findInFolder", async (item = treeView.selection[0]) => {
			if (!item) {
				return
			}
			await vscode.commands.executeCommand("workbench.action.findInFiles", {
				query: "",
				triggerSearch: true,
				filesToInclude: vscode.workspace.asRelativePath(item.resourceUri) || ".",
				excludeSettingAndIgnoreFiles: true,
			})
		}),

		vscode.commands.registerCommand("sortedExplorer.cut", async (item?: FileTreeItem) => {
			const uris = getSelectedItems(item)
			if (cuttingItems) {
				cutDecorationProvider.removeFiles(cuttingItems)
			}
			copyingItems = undefined
			cuttingItems = uris.map(s => s.resourceUri)
			cutDecorationProvider.addFiles(cuttingItems)
			await vscode.commands.executeCommand("setContext", "sortedExplorer.clipboard", "cut")
		}),
		vscode.commands.registerCommand("sortedExplorer.copy", async (item: FileTreeItem) => {
			const uris = getSelectedItems(item)
			if (cuttingItems) {
				cutDecorationProvider.removeFiles(cuttingItems)
				cuttingItems = undefined
			}
			copyingItems = uris.map(s => s.resourceUri)
			await vscode.commands.executeCommand("setContext", "sortedExplorer.clipboard", "copy")
		}),
		vscode.commands.registerCommand("sortedExplorer.paste", async (item = treeView.selection[0]) => {
			const dir = item ? item.collapsibleState !== vscode.TreeItemCollapsibleState.None ? item.resourceUri : vscode.Uri.joinPath(item.resourceUri, "..") : vscode.workspace.workspaceFolders?.[0].uri
			if (!dir) {
				return
			}
			let selectedPath!: vscode.Uri
			if (cuttingItems) {
				for (const item of cuttingItems) {
					const newPath = vscode.Uri.joinPath(dir, path.basename(item.path))
					selectedPath ??= newPath
					await moveFile(item, newPath)
				}
				await vscode.commands.executeCommand("setContext", "sortedExplorer.clipboard", undefined)
				cutDecorationProvider.removeFiles(cuttingItems)
				cuttingItems = undefined
			} else if (copyingItems) {
				for (const item of copyingItems) {
					const newPath = vscode.Uri.joinPath(dir, path.basename(item.path))
					await copyFile(item, newPath)
					selectedPath ??= newPath
				}
				if (selectedPath) {
					await new Promise(s => setTimeout(s, 200))
				}
			} else {
				return
			}
			if (selectedPath) {
				await treeView.reveal(treeProvider.getItemByPath(selectedPath), {
					select: true,
					focus: true,
					expand: true
				})
			}
		}),
		vscode.commands.registerCommand("sortedExplorer.duplicate", async (item = treeView.selection[0]) => {
			const src = item.resourceUri
			const ext = path.extname(src.path)
			const base = path.basename(src.path, ext)
			const newBaseName = `${base}-copy`
			const name = await vscode.window.showInputBox({
				prompt: vscode.l10n.t("Input duplicate name"),
				value: `${newBaseName}${ext}`,
				valueSelection: [0, newBaseName.length]
			})
			if (name) {
				const dest = vscode.Uri.joinPath(src, "..", name)
				await copyFile(src, dest)
				await treeView.reveal(treeProvider.getItemByPath(dest), {
					select: true,
					focus: true,
					expand: true
				})
			}
		}),

		vscode.commands.registerCommand("sortedExplorer.copyPath", async (item = treeView.selection[0]) => {
			if (!item) {
				return
			}
			await vscode.env.clipboard.writeText(item.resourceUri.fsPath ?? item.resourceUri.toString())
		}),
		vscode.commands.registerCommand("sortedExplorer.copyRelativePath", async (item = treeView.selection[0]) => {
			if (!item) {
				return
			}
			await vscode.env.clipboard.writeText(vscode.workspace.asRelativePath(item.resourceUri))
		}),

		vscode.commands.registerCommand("sortedExplorer.renameAllFiles", async (item: FileTreeItem = treeView.selection[0]) => {
			if (item instanceof vscode.Uri) item = { resourceUri: item } as any
			const dir = item ? item.collapsibleState !== vscode.TreeItemCollapsibleState.None ? item.resourceUri : vscode.Uri.joinPath(item.resourceUri, "..") : vscode.workspace.workspaceFolders?.[0].uri
			if (!dir) {
				return
			}
			const files = await vscode.workspace.findFiles(new vscode.RelativePattern(dir, "**/*"))
			if (files.length == 0) {
				vscode.window.showInformationMessage(vscode.l10n.t("No files found in folder."))
				return
			}
			files.sort((x, y) => x.fsPath < y.fsPath ? -1 : x.fsPath > y.fsPath ? 1 : 0)
			const oldNames = files.map(file => path.relative(dir.fsPath, file.fsPath).replaceAll("\\", "/"))
			const tempFile = vscode.Uri.file(path.join(os.tmpdir(), "sortedExplorer.newNames.txt"))
			await vscode.workspace.fs.writeFile(tempFile, Buffer.from(oldNames.join("\n")))
			const event = vscode.workspace.onWillSaveTextDocument(async e => {
				if (e.document == document && e.reason == vscode.TextDocumentSaveReason.Manual) {
					let newNames = document.getText().split(/\r?\n/).filter(line => !!line)
					if (newNames.length !== oldNames.length) {
						await vscode.window.showErrorMessage(vscode.l10n.t("There should be {0} lines in this file.", oldNames.length))
						return
					}
					const edit = new vscode.WorkspaceEdit()
					for (let i = 0; i < oldNames.length; i++) {
						const oldName = oldNames[i]
						const newName = newNames[i]
						if (oldName !== newName) {
							edit.renameFile(vscode.Uri.joinPath(dir, oldName), vscode.Uri.joinPath(dir, newName), { overwrite: false })
						}
					}
					if (await vscode.workspace.applyEdit(edit)) {
						event.dispose()
						setTimeout(async () => {
							const tab = vscode.window.tabGroups.all
								.flatMap(group => group.tabs)
								.find(tab =>
									tab.input instanceof vscode.TabInputText &&
									tab.input.uri.toString() === document.uri.toString()
								)
							if (tab) {
								await vscode.window.tabGroups.close(tab)
							}
							await vscode.workspace.fs.delete(tempFile)
						}, 80)
					}
				}
			})
			const document = await vscode.workspace.openTextDocument(tempFile)
			await vscode.window.showTextDocument(document)
		}),
		vscode.commands.registerCommand("sortedExplorer.rename", async (item = treeView.selection[0]) => {
			if (!item) {
				return
			}
			const oldPath = item.resourceUri
			const oldName = path.basename(oldPath.path)
			const ext = item.collapsibleState !== vscode.TreeItemCollapsibleState.None ? "" : path.extname(oldName)
			const newName = await vscode.window.showInputBox({
				prompt: vscode.l10n.t("Input new name"),
				value: oldName,
				valueSelection: [0, oldName.length - ext.length]
			})
			if (newName && newName !== oldName) {
				await moveFile(oldPath, vscode.Uri.joinPath(oldPath, "..", newName))
			}
		}),
		vscode.commands.registerCommand("sortedExplorer.delete", async (item?: FileTreeItem) => {
			// a workspace folder is only taken out of the workspace, never deleted from disk
			const files = getSelectedItems(item).filter(t => !isWorkspaceFolderRoot(t.resourceUri)).map(t => t.resourceUri)
			if (!files.length) {
				return
			}
			await deleteFile(files)
		}),
		vscode.commands.registerCommand("sortedExplorer.removeFromWorkspace", (item = treeView.selection[0]) => {
			if (!item) {
				return
			}
			const folder = vscode.workspace.getWorkspaceFolder(item.resourceUri)
			if (!folder) {
				return
			}
			vscode.workspace.updateWorkspaceFolders(folder.index, 1)
		}),
		vscode.commands.registerCommand("sortedExplorer.addFolderToWorkspace", async (item = treeView.selection[0]) => {
			if (!item) {
				return
			}
			const folderUris = await vscode.window.showOpenDialog({
				canSelectFiles: false,
				canSelectFolders: true,
				canSelectMany: true,
				openLabel: vscode.l10n.t("Add"),
				defaultUri: vscode.Uri.joinPath(item.resourceUri, ".."),
			})
			if (folderUris) {
				// add next to the folder the menu was opened on
				const index = (vscode.workspace.getWorkspaceFolder(item.resourceUri)?.index ?? -1) + 1
				vscode.workspace.updateWorkspaceFolders(index, 0, ...folderUris.map(folderUri => ({ uri: folderUri })))
			}
		}),

		vscode.commands.registerCommand("sortedExplorer.setLabel", async (item = treeView.selection[0]) => {
			if (!item) {
				return
			}
			const project = treeProvider.getProject(item.resourceUri)
			if (!project) {
				return
			}
			const key = getRelativePath(item.resourceUri)
			const oldLabel = project.labels[key] || path.basename(item.resourceUri.path, path.extname(item.resourceUri.path))
			const newLabel = await vscode.window.showInputBox({
				prompt: vscode.l10n.t("Input new label"),
				value: oldLabel
			})
			if (newLabel !== undefined && newLabel !== oldLabel) {
				project.setLabel(key, newLabel)
				await project.save()
			}
		}),
		vscode.commands.registerCommand("sortedExplorer.moveUp", async (item = treeView.selection[0]) => {
			if (!item) {
				return
			}
			const parentDir = vscode.Uri.joinPath(item.resourceUri, "..")
			const items = await treeProvider.readDirectory(parentDir)
			const index = items.findIndex(t => t.name === item.name)
			if (index <= 0) {
				return
			}
			const temp = items[index]
			items[index] = items[index - 1]
			items[index - 1] = temp
			await saveOrders(treeProvider, parentDir, items)
		}),
		vscode.commands.registerCommand("sortedExplorer.moveDown", async (item = treeView.selection[0]) => {
			if (!item) {
				return
			}
			const parentDir = vscode.Uri.joinPath(item.resourceUri, "..")
			const items = await treeProvider.readDirectory(parentDir)
			const index = items.findIndex(t => t.name === item.name)
			if (index < 0 || index >= items.length - 1) {
				return
			}
			const temp = items[index]
			items[index] = items[index + 1]
			items[index + 1] = temp
			await saveOrders(treeProvider, parentDir, items)
		}),

		vscode.commands.registerCommand("sortedExplorer.toggleCheckbox", () => {
			const config = vscode.workspace.getConfiguration(configSection)
			config.update("showCheckbox", !config.get("showCheckbox", false), vscode.ConfigurationTarget.Global)
		}),
		vscode.commands.registerCommand("sortedExplorer.toggleNumbers", () => {
			const config = vscode.workspace.getConfiguration(configSection)
			config.update("showNumbers", !config.get("showNumbers", false), vscode.ConfigurationTarget.Global)
		}),
	)

	function updateTitle() {
		treeView.title = treeProvider.getWorkspaceFolders().length > 1 ? vscode.l10n.t("Workspace") : treeProvider.getWorkspaceFolders().length === 1 ? treeProvider.getWorkspaceFolders()[0].name : vscode.l10n.t("No workspace")
	}

	function getSelectedItems(item?: FileTreeItem) {
		// Remove parent section if some files inside is selected
		if (treeView.selection.length > 1) {
			return treeView.selection.filter(t => t.collapsibleState === vscode.TreeItemCollapsibleState.None || !treeView.selection.some(s => s.resourceUri.toString().startsWith(t.resourceUri.toString() + "/")))
		}
		return item ? [item] : treeView.selection
	}
}

class FileTreeProvider implements vscode.TreeDataProvider<FileTreeItem> {
	private workspaceFolders: readonly vscode.WorkspaceFolder[]
	private config: SortedExplorerConfig
	private readonly projects = new Map<string, ProjectConfig>()

	constructor(workspaceFolders: readonly vscode.WorkspaceFolder[] | undefined, config: SortedExplorerConfig) {
		this.workspaceFolders = workspaceFolders ?? []
		this.config = config
	}

	getWorkspaceFolders() {
		return this.workspaceFolders
	}

	setWorkspaceFolders(workspaceFolders: readonly vscode.WorkspaceFolder[] | undefined) {
		this.workspaceFolders = workspaceFolders ?? []
		this.projects.clear()
		this.refresh()
	}

	getConfig() {
		return this.config
	}

	setConfig(config: SortedExplorerConfig, callback?: () => void) {
		this.config = config
		this.projects.clear()
		this.refresh(callback)
	}

	getProject(uri: vscode.Uri) {
		return getProject(uri, this.projects)
	}

	private readonly didChangeTreeDataEvent = new vscode.EventEmitter<FileTreeItem | void>()

	get onDidChangeTreeData() { return this.didChangeTreeDataEvent.event }

	refreshTimer: NodeJS.Timeout | undefined = undefined

	refresh(callback?: () => void) {
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer)
		}
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = undefined
			this.itemsCache.clear()
			this.didChangeTreeDataEvent.fire()
			callback?.()
		}, 50)
	}

	async getChildren(element?: FileTreeItem): Promise<FileTreeItem[]> {
		if (element) {
			return await this.readDirectory(element.resourceUri)
		}
		if (this.workspaceFolders.length === 1) {
			return await this.readDirectory(this.workspaceFolders[0].uri)
		}
		return this.workspaceFolders.map(folder => {
			const project = this.getProject(folder.uri)
			return new FileTreeItem(folder.uri, folder.name, project?.labels[""], this.config.showOrginalNames, this.config.showCheckbox ? !!project?.states[""] : undefined, false)
		})
	}

	async readDirectory(dirPath: vscode.Uri): Promise<FileTreeItem[]> {
		const entries = await vscode.workspace.fs.readDirectory(dirPath)
		const project = this.getProject(dirPath)
		const labels = project?.labels ?? {}
		const states = project?.states ?? {}
		const orders = project?.orders ?? emptyOrders
		let dirName = getRelativePath(dirPath)
		if (dirName) {
			dirName += "/"
		}
		const files: FileTreeItem[] = []
		const folders = this.config.foldersFirst ? [] : files
		// Add explicit entries
		for (const fileName of orders.get(dirName) ?? []) {
			const entryIndex = entries.findIndex(entry => entry[0] === fileName)
			if (entryIndex >= 0) {
				const key = dirName + fileName
				const fileType = entries[entryIndex][1]
				// Delete explicit entry from entries
				entries[entryIndex] = entries[entries.length - 1]
				entries.length--
				const isFile = (fileType & vscode.FileType.File) !== 0
				const target = isFile ? files : folders
				const url = vscode.Uri.joinPath(dirPath, fileName)
				const item = this.itemsCache.get(url.toString()) ?? new FileTreeItem(url, fileName, labels[key], this.config.showOrginalNames, this.config.showCheckbox ? !!states[key] : undefined, isFile)
				this.itemsCache.set(item.resourceUri.toString(), item)
				target.push(item)
			}
		}
		// Add remaining entries
		if (!this.config.showListedOnly) {
			// Sort rest entries alphabetically
			entries.sort((left, right) => left[0].localeCompare(right[0]))
			for (const [fileName, fileType] of entries) {
				const key = dirName + fileName
				if (this.ignoreFile(fileName, key)) {
					continue
				}
				const isFile = (fileType & vscode.FileType.File) !== 0
				const target = isFile ? files : folders
				const url = vscode.Uri.joinPath(dirPath, fileName)
				const item = this.itemsCache.get(url.toString()) ?? new FileTreeItem(url, fileName, labels[key], this.config.showOrginalNames, this.config.showCheckbox ? !!states[key] : undefined, isFile)
				this.itemsCache.set(item.resourceUri.toString(), item)
				target.push(item)
			}
		}
		if (this.config.foldersFirst) {
			folders.push(...files)
			if (this.config.showNumbers) {
				let dirCount = 1
				let fileCount = 1
				for (const folder of folders) {
					if (folder.collapsibleState === vscode.TreeItemCollapsibleState.None) {
						folder.label = `${fileCount}. ${folder.label}`
						fileCount++
					} else {
						folder.label = `${dirCount}. ${folder.label}`
						dirCount++
					}
				}
			}
		} else {
			if (this.config.showNumbers) {
				let count = 1
				for (const folder of folders) {
					folder.label = `${count}. ${folder.label}`
					count++
				}
			}
		}
		return folders
	}

	private ignoreFile(fileName: string, key: string) {
		if (this.config.ignore.includes(key) || this.config.ignore.includes(fileName)) {
			return true
		}
		return false
	}

	getTreeItem(element: FileTreeItem): vscode.TreeItem {
		return element
	}

	getParent(element: FileTreeItem): vscode.ProviderResult<FileTreeItem> {
		const uri = element.resourceUri
		// In a multi-root workspace the folder items themselves sit at the root level
		if (this.workspaceFolders.length > 1 && isWorkspaceFolderRoot(uri)) {
			return undefined
		}
		const dirPath = vscode.Uri.joinPath(uri, "..")
		if (this.workspaceFolders.length === 1 && this.workspaceFolders[0].uri.toString() === dirPath.toString()) {
			return undefined
		}
		// Never climb outside the workspace (also stops the no-workspace case)
		if (!vscode.workspace.getWorkspaceFolder(dirPath)) {
			return undefined
		}
		return this.getItemByPath(dirPath)
	}

	private readonly itemsCache = new Map<string, FileTreeItem>()

	getItemByPath(itemPath: vscode.Uri) {
		const cache = this.itemsCache.get(itemPath.toString())
		if (cache) {
			return cache
		}
		const project = this.getProject(itemPath)
		const key = getRelativePath(itemPath)
		return new FileTreeItem(itemPath, path.basename(itemPath.path), project?.labels[key], this.config.showOrginalNames, this.config.showCheckbox ? !!project?.states[key] : undefined, false)
	}
}

class FileTreeItem extends vscode.TreeItem {
	declare resourceUri: vscode.Uri
	readonly name: string
	constructor(resourceUri: vscode.Uri, name: string, label: string | undefined, showName: boolean, checked: boolean | undefined, isFile: boolean) {
		super(resourceUri)
		this.id = resourceUri.toString()
		this.name = name
		this.label = label || name
		if (showName && label) {
			this.description = name
		}
		if (isFile) {
			this.iconPath = vscode.ThemeIcon.File
			this.command = { command: "vscode.open", title: "Open File", arguments: [this.resourceUri] }
			this.collapsibleState = vscode.TreeItemCollapsibleState.None
		} else {
			this.iconPath = vscode.ThemeIcon.Folder
			this.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed
		}
		this.contextValue = isFile ? "file" : isWorkspaceFolderRoot(resourceUri) ? "workspaceFolder" : "folder"
		if (checked !== undefined) {
			this.checkboxState = checked ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked
		}
	}
}

function getConfig(): SortedExplorerConfig {
	const configs = vscode.workspace.getConfiguration(configSection)
	return {
		showOrginalNames: configs.get("showOrginalNames", true),
		ignore: configs.get("ignore", [".DS_Store", ".git", ".idea", ".vs"]),
		foldersFirst: configs.get("foldersFirst", true),
		showCheckbox: configs.get("showCheckbox", false),
		showNumbers: configs.get("showNumbers", false),
		showListedOnly: configs.get("showListedOnly", false),
	}
}

interface SortedExplorerConfig {
	/** Show original names after titles */
	showOrginalNames: boolean
	/** Ignore list */
	ignore: string[]
	/** Show folders first */
	foldersFirst: boolean
	/** Show checkbox */
	showCheckbox: boolean
	/** Show only items listed in the orders */
	showListedOnly: boolean
	/** Show numbers before items */
	showNumbers: boolean
}

type ProjectDataKey = "orders" | "labels" | "states"

interface ProjectEntry {
	label?: string
	state?: boolean
	ordered?: boolean
}

class ProjectConfig {
	/** Custom file orders */
	orders: Map<string, string[]>
	/** Display titles for paths */
	labels: Record<string, string>
	/** Checked state for paths */
	states: Record<string, boolean>
	private orderList: string[]
	private readonly dirty = new Set<ProjectDataKey>()

	constructor(readonly folder: vscode.WorkspaceFolder) {
		const configs = vscode.workspace.getConfiguration(configSection, folder.uri)
		const legacyPrefix = getLegacyPrefix(folder)
		this.orderList = readProjectData(configs, "orders", legacyPrefix, [] as string[])
		this.orders = parseOrders(this.orderList)
		this.labels = readProjectData(configs, "labels", legacyPrefix, {} as Record<string, string>)
		this.states = readProjectData(configs, "states", legacyPrefix, {} as Record<string, boolean>)
	}

	setOrder(dirName: string, names: string[]) {
		this.orders.set(dirName, names)
		this.orderList = formatOrders(this.orders)
		this.dirty.add("orders")
	}

	setLabel(key: string, label: string | undefined) {
		if (label) {
			this.labels[key] = label
		} else {
			delete this.labels[key]
		}
		this.dirty.add("labels")
	}

	setState(key: string, checked: boolean) {
		if (checked) {
			this.states[key] = true
		} else {
			delete this.states[key]
		}
		this.dirty.add("states")
	}

	/** Sync stored data when an item is renamed inside the same folder */
	rename(from: string, to: string) {
		const index = this.orderList.indexOf(from)
		if (index >= 0) {
			this.orderList[index] = to
			this.orders = parseOrders(this.orderList)
			this.dirty.add("orders")
		}
		if (from in this.labels) {
			this.labels = replaceKey(this.labels, from, to)
			this.dirty.add("labels")
		}
		if (from in this.states) {
			this.states = replaceKey(this.states, from, to)
			this.dirty.add("states")
		}
	}

	/** Give a copied item the label and checked state of its source */
	copy(from: string, to: string) {
		if (from in this.labels) {
			this.labels[to] = this.labels[from]
			this.dirty.add("labels")
		}
		if (from in this.states) {
			this.states[to] = this.states[from]
			this.dirty.add("states")
		}
	}

	/** Drop stored data of a deleted item */
	remove(key: string) {
		let changed = false
		for (let i = this.orderList.length - 1; i >= 0; i--) {
			if (this.orderList[i] === key) {
				this.orderList.splice(i, 1)
				changed = true
			}
		}
		if (changed) {
			this.orders = parseOrders(this.orderList)
			this.dirty.add("orders")
		}
		if (key in this.labels) {
			delete this.labels[key]
			this.dirty.add("labels")
		}
		if (key in this.states) {
			delete this.states[key]
			this.dirty.add("states")
		}
	}

	/** Take stored data of an item moved out of another folder */
	moveIn(key: string, entry: ProjectEntry) {
		if (entry.label !== undefined) {
			this.labels[key] = entry.label
			this.dirty.add("labels")
		}
		if (entry.state !== undefined) {
			this.states[key] = entry.state
			this.dirty.add("states")
		}
		if (entry.ordered && !this.orderList.includes(key)) {
			this.orderList.push(key)
			this.orders = parseOrders(this.orderList)
			this.dirty.add("orders")
		}
	}

	/** Drop stored data of an item moved out of this folder and hand it to the destination folder */
	moveOut(key: string): ProjectEntry {
		const entry: ProjectEntry = {
			label: this.labels[key],
			state: key in this.states ? this.states[key] : undefined,
			ordered: this.orderList.includes(key)
		}
		this.remove(key)
		return entry
	}

	async save() {
		if (!this.dirty.size) {
			return
		}
		const keys = Array.from(this.dirty)
		this.dirty.clear()
		const configs = vscode.workspace.getConfiguration(configSection, this.folder.uri)
		for (const key of keys) {
			await configs.update(key, key === "orders" ? this.orderList : this[key], vscode.ConfigurationTarget.WorkspaceFolder)
		}
	}
}

function getProject(uri: vscode.Uri, cache: Map<string, ProjectConfig>) {
	const folder = vscode.workspace.getWorkspaceFolder(uri)
	if (!folder) {
		return undefined
	}
	const key = folder.uri.toString()
	let project = cache.get(key)
	if (!project) {
		project = new ProjectConfig(folder)
		cache.set(key, project)
	}
	return project
}

async function saveProjects(cache: Map<string, ProjectConfig>) {
	for (const project of cache.values()) {
		await project.save()
	}
}

/**
 * Earlier versions kept every folder's entries in the shared workspace settings
 * with a "<folder name>/" prefix, so unprefixed keys are that folder's own data.
 */
function getLegacyPrefix(folder: vscode.WorkspaceFolder) {
	if ((vscode.workspace.workspaceFolders?.length ?? 0) < 2) {
		return ""
	}
	const name = vscode.workspace.asRelativePath(folder.uri)
	return !name || path.isAbsolute(name) ? "" : name + "/"
}

function readProjectData<T extends string[] | Record<string, any>>(configs: vscode.WorkspaceConfiguration, key: string, legacyPrefix: string, defaultValue: T): T {
	const value = configs.get(key, defaultValue)
	// a folder's own settings always store paths relative to that folder, only shared ones may use the legacy keys
	if (!legacyPrefix || configs.inspect(key)?.workspaceFolderValue !== undefined) {
		return value
	}
	return selectLegacy(value, legacyPrefix)
}

function selectLegacy<T extends string[] | Record<string, any>>(value: T, prefix: string): T {
	const rootName = prefix.slice(0, -1)
	if (Array.isArray(value)) {
		return value.filter(t => t.startsWith(prefix)).map(t => t.substring(prefix.length)) as T
	}
	const result: Record<string, any> = {}
	for (const key in value) {
		if (key.startsWith(prefix)) {
			result[key.substring(prefix.length)] = value[key]
		} else if (key === rootName) {
			result[""] = value[key]
		}
	}
	return result as T
}

function parseOrders(orders: string[]) {
	const result = new Map<string, string[]>()
	for (const filePath of orders) {
		const dirPath = getDir(filePath)
		const entries = result.get(dirPath)
		const fileName = path.basename(filePath)
		if (entries) {
			entries.push(fileName)
		} else {
			result.set(dirPath, [fileName])
		}
	}
	return result
}

function getDir(name: string) {
	const slash = name.lastIndexOf("/")
	return slash >= 0 ? name.substring(0, slash + 1) : ""
}

class DragDropController implements vscode.TreeDragAndDropController<FileTreeItem> {
	private readonly fileTreeProvider: FileTreeProvider
	constructor(fileTreeProvider: FileTreeProvider) {
		this.fileTreeProvider = fileTreeProvider
	}

	get dragMimeTypes() { return ["text/uri-list"] }
	get dropMimeTypes() { return ["text/uri-list"] }

	handleDrag(source: readonly FileTreeItem[], dataTransfer: vscode.DataTransfer) {
		dataTransfer.set("text/uri-list", new vscode.DataTransferItem(source.map(item => item.resourceUri.toString()).join("\r\n")))
		dataTransfer.set("application/vnd.code.tree.sortedExplorer", new vscode.DataTransferItem(source.length.toString()))
	}

	async handleDrop(target: FileTreeItem | undefined, dataTransfer: vscode.DataTransfer) {
		const transferItem = dataTransfer.get("text/uri-list")
		if (!transferItem) {
			return
		}
		const dragData = transferItem.value
		if (typeof dragData !== "string") {
			return
		}
		const orginalTarget = target
		if (!target) {
			const rootItems = await this.fileTreeProvider.getChildren()
			if (!rootItems.length) {
				return
			}
			target = rootItems[rootItems.length - 1]
		}
		const sourceUris = dragData.split("\r\n").map(uri => vscode.Uri.parse(uri))
		const fromExplorer = !!dataTransfer.get("application/vnd.code.tree.sortedExplorer")
		await this.dragMove(sourceUris, target.resourceUri, orginalTarget ? orginalTarget.collapsibleState !== vscode.TreeItemCollapsibleState.None : false, fromExplorer)
	}

	private async dragMove(sources: vscode.Uri[], target: vscode.Uri, targetIsDir: boolean, move: boolean) {
		// If target is not in workspace, cannot move
		if (!vscode.workspace.getWorkspaceFolder(target)) {
			return
		}
		// Move all source files into the same directory as target file
		const targetDir = vscode.Uri.joinPath(target, "..")
		const targetDirUrl = targetDir.toString()
		for (let i = 0; i < sources.length; i++) {
			const source = sources[i]
			if (vscode.Uri.joinPath(source, "..").toString() !== targetDirUrl) {
				// If target is a folder and some source files are not sibling of target, assume users are intent to move files into folders.
				if (targetIsDir) {
					await this.dragInto(sources, target, move)
					return
				}
				const newSource = sources[i] = vscode.Uri.joinPath(targetDir, path.basename(source.path))
				if (move) {
					await moveFile(source, newSource)
				} else {
					await copyFile(source, newSource)
				}
			}
		}
		// Detect move direction according to the original order
		const items = await this.fileTreeProvider.readDirectory(targetDir)
		// If source is a file and target is a folder with `foldersFirst` on, assume users are intent to move files into folders.
		if (targetIsDir && this.fileTreeProvider.getConfig().foldersFirst && sources.every(source => {
			const sourceBaseName = path.basename(source.path)
			const item = items.find(item => item.name === sourceBaseName)
			return item && item.collapsibleState === vscode.TreeItemCollapsibleState.None
		})) {
			await this.dragInto(sources, target, move)
			return
		}
		const sourceBaseName = path.basename(sources[0].path)
		const targetBaseName = path.basename(target.path)
		const sourceIndex = items.findLastIndex
			? items.findLastIndex(item => item.name === sourceBaseName)
			: items.findIndex(item => item.name === sourceBaseName)
		const targetIndex = items.findIndex(item => item.name === targetBaseName)
		const insertBefore = sourceIndex >= 0 && targetIndex >= 0
			? targetIndex < items.length - 1 && sourceIndex !== targetIndex - 1
			: sourceBaseName.localeCompare(targetBaseName) >= 0
		// Sort items
		if (sources.length === 1 && sourceIndex >= 0 && targetIndex >= 0) {
			if (insertBefore) {
				if (sourceIndex + 1 === targetIndex) {
					return
				}
			} else {
				if (sourceIndex - 1 === targetIndex) {
					return
				}
			}
			items.splice(targetIndex, 0, items.splice(sourceIndex, 1)[0])
		} else {
			const movedItems: FileTreeItem[] = []
			for (const source of sources) {
				const baseName = path.basename(source.path)
				const itemIndex = items.findIndex(item => item.name === baseName)
				if (itemIndex >= 0) {
					movedItems.push(items[itemIndex])
					items.splice(itemIndex, 1)
				}
			}
			let insertIndex = items.findIndex(item => item.name === targetBaseName)
			if (insertIndex < 0) {
				insertIndex = items.length
			} else if (!insertBefore) {
				insertIndex++
			}
			items.splice(insertIndex, 0, ...movedItems)
		}
		// Save orders
		await saveOrders(this.fileTreeProvider, targetDir, items)
	}

	private async dragInto(sources: vscode.Uri[], target: vscode.Uri, move: boolean) {
		for (const source of sources) {
			const newSource = vscode.Uri.joinPath(target, path.basename(source.path))
			if (move) {
				await moveFile(source, newSource)
			} else {
				await copyFile(source, newSource)
			}
		}
	}
}

async function moveFile(from: vscode.Uri, to: vscode.Uri) {
	const edit = new vscode.WorkspaceEdit()
	edit.renameFile(from, to, {
		overwrite: false,
	})
	const success = await vscode.workspace.applyEdit(edit)
	if (!success && await existsFile(to)) {
		const result = await vscode.window.showWarningMessage(
			vscode.l10n.t(`The destination already contains a file named "{0}".\n\nDo you want to replace it?`, path.basename(to.path)),
			{ modal: true },
			vscode.l10n.t("Replace")
		)
		if (result === vscode.l10n.t("Replace")) {
			const edit = new vscode.WorkspaceEdit()
			edit.renameFile(from, to, {
				overwrite: true
			})
			await vscode.workspace.applyEdit(edit)
		}
	}
}

async function copyFile(from: vscode.Uri, to: vscode.Uri) {
	try {
		await vscode.workspace.fs.copy(from, to, {
			overwrite: false
		})
	} catch (e) {
		const result = await vscode.window.showWarningMessage(
			vscode.l10n.t(`The destination already contains a file named "{0}".\n\nDo you want to replace it?`, path.basename(to.path)),
			{ modal: true },
			vscode.l10n.t("Replace")
		)
		if (result === vscode.l10n.t("Replace")) {
			await vscode.workspace.fs.copy(from, to, {
				overwrite: true
			})
		}
	}
	await handleCopyFiles([{ oldUri: from, newUri: to }])
}

async function deleteFile(files: readonly vscode.Uri[]) {
	const edit = new vscode.WorkspaceEdit()
	for (const file of files) {
		edit.deleteFile(file, { recursive: true })
	}
	await vscode.workspace.applyEdit(edit)
}

async function existsFile(uri: vscode.Uri) {
	try {
		await vscode.workspace.fs.stat(uri)
		return true
	} catch {
		return false
	}
}

async function saveOrders(treeProvider: FileTreeProvider, parentDir: vscode.Uri, items: FileTreeItem[]) {
	const project = treeProvider.getProject(parentDir)
	if (!project) {
		return
	}
	const relativePath = getRelativePath(parentDir)
	project.setOrder(relativePath ? relativePath + "/" : "", items.map(item => item.name))
	await project.save()
}

function formatOrders(orders: Map<string, string[]>) {
	const result: string[] = []
	const processed = new Set<string>()
	processKeys("")
	for (const key of orders.keys()) {
		processKeys(key)
	}
	return result

	function processKeys(key: string) {
		if (processed.has(key)) {
			return
		}
		processed.add(key)
		const fileNames = orders.get(key)
		if (fileNames) {
			for (const fileName of fileNames) {
				const path = key + fileName
				result.push(path)
				processKeys(path + "/")
			}
		}
	}
}

async function handleRenameFiles(files: readonly { readonly oldUri: vscode.Uri, readonly newUri: vscode.Uri }[]) {
	const cache = new Map<string, ProjectConfig>()
	for (const file of files) {
		const from = getRelativePath(file.oldUri)
		const to = getRelativePath(file.newUri)
		const source = getProject(file.oldUri, cache)
		const target = getProject(file.newUri, cache)
		if (source && target) {
			if (source === target) {
				source.rename(from, to)
			} else {
				target.moveIn(to, source.moveOut(from))
			}
		} else if (source) {
			source.moveOut(from)
		} else if (target) {
			target.moveIn(to, { ordered: false })
		}
	}
	await saveProjects(cache)
}

async function handleCopyFiles(files: readonly { readonly oldUri: vscode.Uri, readonly newUri: vscode.Uri }[]) {
	const cache = new Map<string, ProjectConfig>()
	for (const file of files) {
		const from = getRelativePath(file.oldUri)
		const to = getRelativePath(file.newUri)
		const source = getProject(file.oldUri, cache)
		const target = getProject(file.newUri, cache)
		if (!source || !target) {
			continue
		}
		if (source === target) {
			source.copy(from, to)
		} else {
			target.moveIn(to, { label: source.labels[from], state: source.states[from] })
		}
	}
	await saveProjects(cache)
}

async function handleDeleteFiles(files: readonly vscode.Uri[]) {
	const cache = new Map<string, ProjectConfig>()
	for (const file of files) {
		getProject(file, cache)?.remove(getRelativePath(file))
	}
	await saveProjects(cache)
}

function getRelativePath(uri: vscode.Uri) {
	const folder = vscode.workspace.getWorkspaceFolder(uri)
	if (folder) {
		return path.posix.relative(folder.uri.path, uri.path)
	}
	return uri.toString()
}

function isWorkspaceFolderRoot(uri: vscode.Uri) {
	return vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() === uri.toString()
}

function replaceKey<T>(obj: Record<string, T>, from: string, to: string) {
	const result: Record<string, T> = {}
	for (const key in obj) {
		if (key === from) {
			result[to] = obj[from]
			continue
		}
		result[key] = obj[key]
	}
	return result
}

class CutFileDecorationProvider implements vscode.FileDecorationProvider {
	private readonly onDidChangeFileDecorationsEvent = new vscode.EventEmitter<vscode.Uri | vscode.Uri[]>();
	get onDidChangeFileDecorations() { return this.onDidChangeFileDecorationsEvent.event }

	private readonly files = new Set<string>()

	addFiles(uris: vscode.Uri[]): void {
		for (const uri of uris) {
			this.files.add(uri.toString())
		}
		this.onDidChangeFileDecorationsEvent.fire(uris)
	}

	removeFiles(uris: vscode.Uri[]): void {
		for (const uri of uris) {
			this.files.delete(uri.toString())
		}
		this.onDidChangeFileDecorationsEvent.fire(uris)
	}

	clearFiles(): void {
		const uris = Array.from(this.files).map(uriStr => vscode.Uri.parse(uriStr))
		this.files.clear()
		this.onDidChangeFileDecorationsEvent.fire(uris)
	}

	provideFileDecoration(uri: vscode.Uri): vscode.ProviderResult<vscode.FileDecoration> {
		if (this.files.has(uri.toString())) {
			return new vscode.FileDecoration("✂", vscode.l10n.t("Cut (ready to paste)"), new vscode.ThemeColor("disabledForeground"))
		}
		return undefined
	}
}