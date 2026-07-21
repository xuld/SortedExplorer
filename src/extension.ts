import * as vscode from "vscode"
import * as path from "path"

const configSection = "sortedExplorer"

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
	context.subscriptions.push(treeView)
	updateTitle()

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
			const ext = item && item.collapsibleState === vscode.TreeItemCollapsibleState.None ? path.extname(item.resourceUri.path) : ""
			const name = await vscode.window.showInputBox({ prompt: vscode.l10n.t("Input file name"), value: "untitled-1" + ext })
			if (name) {
				const filePath = vscode.Uri.joinPath(dir, name)
				await vscode.workspace.fs.writeFile(filePath, new Uint8Array())
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
		vscode.commands.registerCommand("sortedExplorer.openInTerminal", (item = treeView.selection[0]) => {
			const dir = item ? item.collapsibleState !== vscode.TreeItemCollapsibleState.None ? item.resourceUri : vscode.Uri.joinPath(item.resourceUri, "..") : vscode.workspace.workspaceFolders?.[0].uri
			if (!dir) {
				return
			}
			vscode.window.createTerminal({ cwd: dir }).show()
		}),

		vscode.commands.registerCommand("sortedExplorer.openFile", async (uri: vscode.Uri) => {
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri))
		}),
		vscode.commands.registerCommand("sortedExplorer.openToSide", async (item = treeView.selection[0]) => {
			if (!item) {
				return
			}
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(item.resourceUri), vscode.ViewColumn.Beside)
		}),
		vscode.commands.registerCommand("sortedExplorer.openWith", (item = treeView.selection[0]) => {
			vscode.commands.executeCommand("vscode.openWith", item.resourceUri)
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
					try {
						await vscode.workspace.fs.copy(item, newPath, {
							overwrite: false
						})
					} catch (e: any) {
						vscode.window.showErrorMessage(e.message)
						continue
					}
					selectedPath ??= newPath
				}
				if (selectedPath) {
					await new Promise(s => setTimeout(s, 100))
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
			const name = await vscode.window.showInputBox({
				prompt: vscode.l10n.t("Input duplicate name"),
				value: `${base}-copy${ext}`
			})
			if (name) {
				const dest = vscode.Uri.joinPath(src, "..", name)
				await vscode.workspace.fs.copy(src, dest, {
					overwrite: false
				})
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
			if (item) {
				return
			}
			await vscode.env.clipboard.writeText(vscode.workspace.asRelativePath(item.resourceUri))
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
			for (const selction of getSelectedItems(item)) {
				const edit = new vscode.WorkspaceEdit()
				edit.deleteFile(selction.resourceUri, { recursive: true })
				await vscode.workspace.applyEdit(edit)
			}
		}),

		vscode.commands.registerCommand("sortedExplorer.setLabel", async (item = treeView.selection[0]) => {
			if (!item) {
				return
			}
			const key = treeProvider.getRelativePath(item.resourceUri)
			let labels = treeProvider.getConfig().labels
			const oldLabel = labels[key] || path.basename(item.resourceUri.path)
			const newLabel = await vscode.window.showInputBox({
				prompt: vscode.l10n.t("Input new label"),
				value: oldLabel
			})
			if (newLabel !== undefined && newLabel !== oldLabel) {
				if (newLabel) {
					labels[key] = newLabel
				} else {
					labels[key] = undefined!
				}
				await vscode.workspace.getConfiguration(configSection).update("labels", labels)
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
	)

	function updateTitle() {
		treeView.title = treeProvider.getWorkspaceFolders().length === 1 ? treeProvider.getWorkspaceFolders()[0].name : vscode.l10n.t("No workspace")
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

	constructor(workspaceFolders: readonly vscode.WorkspaceFolder[] | undefined, config: SortedExplorerConfig) {
		this.workspaceFolders = workspaceFolders ?? []
		this.config = config
	}

	getWorkspaceFolders() {
		return this.workspaceFolders
	}

	setWorkspaceFolders(workspaceFolders: readonly vscode.WorkspaceFolder[] | undefined) {
		this.workspaceFolders = workspaceFolders ?? []
		this.refresh()
	}

	getConfig() {
		return this.config
	}

	setConfig(config: SortedExplorerConfig) {
		this.config = config
		this.refresh()
	}

	private readonly didChangeTreeDataEvent = new vscode.EventEmitter<FileTreeItem | void>()

	get onDidChangeTreeData() { return this.didChangeTreeDataEvent.event }

	refresh() {
		this.itemsCache.clear()
		this.didChangeTreeDataEvent.fire()
	}

	async getChildren(element?: FileTreeItem): Promise<FileTreeItem[]> {
		if (element) {
			return await this.readDirectory(element.resourceUri)
		}
		if (this.workspaceFolders.length === 1) {
			return await this.readDirectory(this.workspaceFolders[0].uri)
		}
		return this.workspaceFolders.map(folder => new FileTreeItem(folder.uri, folder.name, this.config.labels[folder.name] ?? folder.name, false))
	}

	async readDirectory(dirPath: vscode.Uri): Promise<FileTreeItem[]> {
		const entries = await vscode.workspace.fs.readDirectory(dirPath)
		let dirName = this.getRelativePath(dirPath)
		if (dirName) {
			dirName += "/"
		}
		const files: FileTreeItem[] = []
		const folders = this.config.foldersFirst ? [] : files
		// Add explicit entries
		for (const fileName of this.config.orders.get(dirName) ?? []) {
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
				const item = this.itemsCache.get(url.toString()) ?? new FileTreeItem(url, fileName, this.config.labels[key] ?? fileName, isFile)
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
				const item = this.itemsCache.get(url.toString()) ?? new FileTreeItem(url, fileName, this.config.labels[key] ?? fileName, isFile)
				this.itemsCache.set(item.resourceUri.toString(), item)
				target.push(item)
			}
		}
		if (this.config.foldersFirst) {
			folders.push(...files)
		}
		if (this.config.showNumbers) {
			for (let i = 0; i < folders.length; i++) {
				folders[i].description = ` [${i + 1}]`
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

	getRelativePath(path: vscode.Uri) {
		return this.workspaceFolders.length === 1 && this.workspaceFolders[0].uri.toString() === path.toString() ? "" : vscode.workspace.asRelativePath(path)
	}

	getTreeItem(element: FileTreeItem): vscode.TreeItem {
		return element
	}

	getParent(element: FileTreeItem): vscode.ProviderResult<FileTreeItem> {
		const dirPath = vscode.Uri.joinPath(element.resourceUri, "..")
		if (this.workspaceFolders.length === 1 && this.workspaceFolders[0].uri.toString() === dirPath.toString()) {
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
		const name = path.basename(itemPath.path)
		const label = this.config.labels[this.getRelativePath(itemPath)] ?? name
		return new FileTreeItem(itemPath, name, label, false)
	}
}

class FileTreeItem extends vscode.TreeItem {
	declare resourceUri: vscode.Uri
	readonly name: string
	constructor(resourceUri: vscode.Uri, name: string, label: string, isFile: boolean) {
		super(resourceUri)
		this.name = name
		this.label = label
		if (isFile) {
			this.iconPath = vscode.ThemeIcon.File
			this.command = { command: "vscode.open", title: "Open File", arguments: [this.resourceUri] }
			this.collapsibleState = vscode.TreeItemCollapsibleState.None
		} else {
			this.iconPath = vscode.ThemeIcon.Folder
			this.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed
		}
		this.contextValue = isFile ? "file" : "folder"
	}
}

class DragDropController implements vscode.TreeDragAndDropController<FileTreeItem> {
	private readonly fileTreeProvider: FileTreeProvider
	constructor(fileTreeProvider: FileTreeProvider) {
		this.fileTreeProvider = fileTreeProvider
	}

	get dragMimeTypes() { return ["text/url-list"] }
	get dropMimeTypes() { return ["text/url-list"] }

	handleDrag(source: readonly FileTreeItem[], dataTransfer: vscode.DataTransfer) {
		dataTransfer.set("text/url-list", new vscode.DataTransferItem(source.map(item => item.resourceUri.toString()).join("\r\n")))
	}

	async handleDrop(target: FileTreeItem | undefined, dataTransfer: vscode.DataTransfer) {
		const transferItem = dataTransfer.get("text/url-list")
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
		await this.dragMove(sourceUris, target.resourceUri, orginalTarget ? orginalTarget.collapsibleState !== vscode.TreeItemCollapsibleState.None : false)
	}

	private async dragMove(sources: vscode.Uri[], target: vscode.Uri, targetIsDir: boolean) {
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
					await this.moveInto(sources, target)
					return
				}
				const newSource = sources[i] = vscode.Uri.joinPath(targetDir, path.basename(source.path))
				await moveFile(source, newSource)
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
			await this.moveInto(sources, target)
			return
		}
		const sourceBaseName = path.basename(sources[0].path)
		const targetBaseName = path.basename(target.path)
		const sourceIndex = items.findIndex(item => item.name === sourceBaseName)
		const targetIndex = items.findIndex(item => item.name === targetBaseName)
		const insertBefore = sourceIndex >= 0 && targetIndex >= 0 ? sourceIndex >= targetIndex : sourceBaseName.localeCompare(targetBaseName) >= 0
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

	private async moveInto(sources: vscode.Uri[], target: vscode.Uri) {
		for (const source of sources) {
			await moveFile(source, vscode.Uri.joinPath(target, path.basename(source.path)))
		}
	}
}

async function moveFile(from: vscode.Uri, to: vscode.Uri) {
	try {
		await vscode.workspace.fs.stat(to)
	} catch (e) {
		await vscode.workspace.fs.rename(from, to, {
			overwrite: false
		})
		return
	}
	const result = await vscode.window.showWarningMessage(
		vscode.l10n.t(`The destination already contains a file named "{0}".\n\nDo you want to replace it?`, path.basename(to.path)),
		{ modal: true },
		vscode.l10n.t("Replace")
	)
	if (result === vscode.l10n.t("Replace")) {
		await vscode.workspace.fs.rename(from, to, {
			overwrite: true
		})
	}
}

async function saveOrders(treeProvider: FileTreeProvider, parentDir: vscode.Uri, items: FileTreeItem[]) {
	const orders = treeProvider.getConfig().orders
	const relativePath = treeProvider.getRelativePath(parentDir)
	orders.set(relativePath ? relativePath + "/" : "", items.map(item => item.name))
	await vscode.workspace.getConfiguration(configSection).update("orders", formatOrders(orders))
}

function getConfig(): SortedExplorerConfig {
	const configs = vscode.workspace.getConfiguration(configSection)
	return {
		orders: parseOrders(configs.get("orders", [] as string[])),
		labels: configs.get("labels", {} as Record<string, string>),
		ignore: configs.get("ignore", [".DS_Store", ".git", ".idea", ".vs"]),
		foldersFirst: configs.get("foldersFirst", true),
		showNumbers: configs.get("showNumbers", false),
		showListedOnly: configs.get("showListedOnly", false),
	}
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

interface SortedExplorerConfig {
	/** Custom file orders */
	orders: Map<string, string[]>
	/** Display labels for paths */
	labels: Record<string, string>
	/** Ignore list */
	ignore: string[]
	/** Show folders first */
	foldersFirst: boolean
	/** Show only items listed in the orders */
	showListedOnly: boolean
	/** Show numbers before items */
	showNumbers: boolean
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