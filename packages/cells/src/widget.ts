/*-----------------------------------------------------------------------------
| Copyright (c) Jupyter Development Team.
| Distributed under the terms of the Modified BSD License.
|----------------------------------------------------------------------------*/

import { IClientSession } from '@jupyterlab/apputils';

import { AttachmentsResolver } from '@jupyterlab/attachments';

import { Debouncer, nbformat } from '@jupyterlab/coreutils';

import { CodeEditor, CodeEditorWrapper } from '@jupyterlab/codeeditor';

import { DatastoreExt } from '@jupyterlab/datastore';

import {
  OutputArea,
  OutputAreaData,
  SimplifiedOutputArea,
  IOutputPrompt,
  OutputPrompt,
  IStdin,
  Stdin
} from '@jupyterlab/outputarea';

import {
  IRenderMime,
  IRenderMimeRegistry,
  MimeModel,
  OutputData
} from '@jupyterlab/rendermime';

import { KernelMessage, Kernel } from '@jupyterlab/services';

import {
  JSONObject,
  PromiseDelegate,
  ReadonlyJSONObject
} from '@phosphor/coreutils';

import { Datastore, MapField, RegisterField } from '@phosphor/datastore';

import { IDisposable } from '@phosphor/disposable';

import { Message } from '@phosphor/messaging';

import { PanelLayout, Panel, Widget } from '@phosphor/widgets';

import { InputCollapser, OutputCollapser } from './collapser';

import {
  CellHeader,
  CellFooter,
  ICellHeader,
  ICellFooter
} from './headerfooter';

import { InputArea, IInputPrompt, InputPrompt } from './inputarea';

import { ICellData, CellData } from './data';

import { InputPlaceholder, OutputPlaceholder } from './placeholder';

/**
 * The CSS class added to cell widgets.
 */
const CELL_CLASS = 'jp-Cell';

/**
 * The CSS class added to the cell header.
 */
const CELL_HEADER_CLASS = 'jp-Cell-header';

/**
 * The CSS class added to the cell footer.
 */
const CELL_FOOTER_CLASS = 'jp-Cell-footer';

/**
 * The CSS class added to the cell input wrapper.
 */
const CELL_INPUT_WRAPPER_CLASS = 'jp-Cell-inputWrapper';

/**
 * The CSS class added to the cell output wrapper.
 */
const CELL_OUTPUT_WRAPPER_CLASS = 'jp-Cell-outputWrapper';

/**
 * The CSS class added to the cell input area.
 */
const CELL_INPUT_AREA_CLASS = 'jp-Cell-inputArea';

/**
 * The CSS class added to the cell output area.
 */
const CELL_OUTPUT_AREA_CLASS = 'jp-Cell-outputArea';

/**
 * The CSS class added to the cell input collapser.
 */
const CELL_INPUT_COLLAPSER_CLASS = 'jp-Cell-inputCollapser';

/**
 * The CSS class added to the cell output collapser.
 */
const CELL_OUTPUT_COLLAPSER_CLASS = 'jp-Cell-outputCollapser';

/**
 * The class name added to the cell when readonly.
 */
const READONLY_CLASS = 'jp-mod-readOnly';

/**
 * The class name added to code cells.
 */
const CODE_CELL_CLASS = 'jp-CodeCell';

/**
 * The class name added to markdown cells.
 */
const MARKDOWN_CELL_CLASS = 'jp-MarkdownCell';

/**
 * The class name added to rendered markdown output widgets.
 */
const MARKDOWN_OUTPUT_CLASS = 'jp-MarkdownOutput';

/**
 * The class name added to raw cells.
 */
const RAW_CELL_CLASS = 'jp-RawCell';

/**
 * The class name added to a rendered input area.
 */
const RENDERED_CLASS = 'jp-mod-rendered';

const NO_OUTPUTS_CLASS = 'jp-mod-noOutputs';

/**
 * The text applied to an empty markdown cell.
 */
const DEFAULT_MARKDOWN_TEXT = 'Type Markdown and LaTeX: $ α^2 $';

/**
 * The timeout to wait for change activity to have ceased before rendering.
 */
const RENDER_TIMEOUT = 1000;

/******************************************************************************
 * Cell
 ******************************************************************************/

/**
 * A base cell widget.
 */
export class Cell extends Widget {
  /**
   * Construct a new base cell widget.
   */
  constructor(options: Cell.IOptions) {
    super();
    this.addClass(CELL_CLASS);
    let data: ICellData.DataLocation;
    if (options.data) {
      data = this._data = options.data;
    } else {
      const datastore = CellData.createStore();
      data = this._data = {
        record: {
          datastore,
          schema: CellData.SCHEMA,
          record: 'data'
        },
        outputs: {
          datastore,
          schema: OutputData.SCHEMA
        }
      };
    }
    let contentFactory = (this.contentFactory =
      options.contentFactory || Cell.defaultContentFactory);
    this.layout = new PanelLayout();

    // Header
    let header = contentFactory.createCellHeader();
    header.addClass(CELL_HEADER_CLASS);
    (this.layout as PanelLayout).addWidget(header);

    // Input
    let inputWrapper = (this._inputWrapper = new Panel());
    inputWrapper.addClass(CELL_INPUT_WRAPPER_CLASS);
    let inputCollapser = new InputCollapser();
    inputCollapser.addClass(CELL_INPUT_COLLAPSER_CLASS);
    let input = (this._input = new InputArea({
      data,
      contentFactory,
      updateOnShow: options.updateEditorOnShow
    }));
    input.addClass(CELL_INPUT_AREA_CLASS);
    inputWrapper.addWidget(inputCollapser);
    inputWrapper.addWidget(input);
    (this.layout as PanelLayout).addWidget(inputWrapper);

    this._inputPlaceholder = new InputPlaceholder(() => {
      this.inputHidden = !this.inputHidden;
    });

    // Footer
    let footer = this.contentFactory.createCellFooter();
    footer.addClass(CELL_FOOTER_CLASS);
    (this.layout as PanelLayout).addWidget(footer);

    // Editor settings
    if (options.editorConfig) {
      Object.keys(options.editorConfig).forEach(
        (key: keyof CodeEditor.IConfig) => {
          this.editor.setOption(key, options.editorConfig[key]);
        }
      );
    }

    this._metadataListener = DatastoreExt.listenField(
      { ...this.data.record, field: 'metadata' },
      this.onMetadataChanged,
      this
    );
  }

  /**
   * Initialize view state from model.
   *
   * #### Notes
   * Should be called after construction. For convenience, returns this, so it
   * can be chained in the construction, like `new Foo().initializeState();`
   */
  initializeState(): this {
    this.loadCollapseState();
    this.loadEditableState();
    return this;
  }

  /**
   * The content factory used by the widget.
   */
  readonly contentFactory: Cell.IContentFactory;

  /**
   * The type of the cell widget.
   */
  type: nbformat.CellType;

  /**
   * Get the prompt node used by the cell.
   */
  get promptNode(): HTMLElement {
    if (!this._inputHidden) {
      return this._input.promptNode;
    } else {
      return (this._inputPlaceholder.node as HTMLElement)
        .firstElementChild as HTMLElement;
    }
  }

  /**
   * Get the CodeEditorWrapper used by the cell.
   */
  get editorWidget(): CodeEditorWrapper {
    return this._input.editorWidget;
  }

  /**
   * Get the CodeEditor used by the cell.
   */
  get editor(): CodeEditor.IEditor {
    return this._input.editor;
  }

  /**
   * Get the model used by the cell.
   */
  get data(): ICellData.DataLocation {
    return this._data;
  }

  /**
   * Get the input area for the cell.
   */
  get inputArea(): InputArea {
    return this._input;
  }

  /**
   * The read only state of the cell.
   */
  get readOnly(): boolean {
    return this._readOnly;
  }
  set readOnly(value: boolean) {
    if (value === this._readOnly) {
      return;
    }
    this._readOnly = value;
    if (this.syncEditable) {
      this.saveEditableState();
    }
    this.update();
  }

  /**
   * Save view editable state to model
   */
  saveEditableState() {
    let metadata = DatastoreExt.getField({
      ...this.data.record,
      field: 'metadata'
    }) as JSONObject;
    const current = metadata['editable'];

    if (
      (this.readOnly && current === false) ||
      (!this.readOnly && current === undefined)
    ) {
      return;
    }

    DatastoreExt.withTransaction(this.data.record.datastore, () => {
      if (this.readOnly) {
        DatastoreExt.updateField(
          { ...this.data.record, field: 'metadata' },
          { editable: false }
        );
      } else {
        DatastoreExt.updateField(
          { ...this.data.record, field: 'metadata' },
          { editable: null }
        );
      }
    });
  }

  /**
   * Load view editable state from model.
   */
  loadEditableState() {
    const metadata = DatastoreExt.getField({
      ...this.data.record,
      field: 'metadata'
    });
    this.readOnly = metadata['editable'] === false;
  }

  /**
   * A promise that resolves when the widget renders for the first time.
   */
  get ready(): Promise<void> {
    return Promise.resolve(undefined);
  }

  /**
   * Set the prompt for the widget.
   */
  setPrompt(value: string): void {
    this._input.setPrompt(value);
  }

  /**
   * The view state of input being hidden.
   */
  get inputHidden(): boolean {
    return this._inputHidden;
  }
  set inputHidden(value: boolean) {
    if (this._inputHidden === value) {
      return;
    }
    let layout = this._inputWrapper.layout as PanelLayout;
    if (value) {
      this._input.parent = null;
      layout.addWidget(this._inputPlaceholder);
    } else {
      this._inputPlaceholder.parent = null;
      layout.addWidget(this._input);
    }
    this._inputHidden = value;
    if (this.syncCollapse) {
      this.saveCollapseState();
    }
    this.handleInputHidden(value);
  }

  /**
   * Save view collapse state to model
   */
  saveCollapseState() {
    /*const jupyter = {
      ...(this.model.metadata['jupyter'] as any)
    };

    if (
      (this.inputHidden && jupyter.source_hidden === true) ||
      (!this.inputHidden && jupyter.source_hidden === undefined)
    ) {
      return;
    }

    if (this.inputHidden) {
      jupyter.source_hidden = true;
    } else {
      delete jupyter.source_hidden;
    }
    DatastoreExt.withTransaction(this.model.record.datastore, () => {
      if (Object.keys(jupyter).length === 0) {
        DatastoreExt.updateField(
          { ...this.model.record, field: 'metadata' },
          { jupyter: null }
        );
      } else {
        DatastoreExt.updateField(
          { ...this.model.record, field: 'metadata' },
          { jupyter }
        );
      }
    });*/
  }

  /**
   * Revert view collapse state from model.
   */
  loadCollapseState() {
    // const jupyter = (this.model.metadata['jupyter'] as any) || {};
    // this.inputHidden = !!jupyter.source_hidden;
  }

  /**
   * Handle the input being hidden.
   *
   * #### Notes
   * This is called by the `inputHidden` setter so that subclasses
   * can perform actions upon the input being hidden without accessing
   * private state.
   */
  protected handleInputHidden(value: boolean): void {
    return;
  }

  /**
   * Whether to sync the collapse state to the cell model.
   */
  get syncCollapse(): boolean {
    return this._syncCollapse;
  }
  set syncCollapse(value: boolean) {
    if (this._syncCollapse === value) {
      return;
    }
    this._syncCollapse = value;
    if (value) {
      this.loadCollapseState();
    }
  }

  /**
   * Whether to sync the editable state to the cell model.
   */
  get syncEditable(): boolean {
    return this._syncEditable;
  }
  set syncEditable(value: boolean) {
    if (this._syncEditable === value) {
      return;
    }
    this._syncEditable = value;
    if (value) {
      this.loadEditableState();
    }
  }

  /**
   * Clone the cell, using the same model.
   */
  clone(): Cell {
    let constructor = this.constructor as typeof Cell;
    return new constructor({
      data: this._data,
      contentFactory: this.contentFactory
    });
  }

  /**
   * Dispose of the resources held by the widget.
   */
  dispose() {
    // Do nothing if already disposed.
    if (this.isDisposed) {
      return;
    }
    this._metadataListener.dispose();

    this._input = null;
    this._data = null;
    this._inputWrapper = null;
    this._inputPlaceholder = null;
    super.dispose();
  }

  /**
   * Handle `after-attach` messages.
   */
  protected onAfterAttach(msg: Message): void {
    this.update();
  }

  /**
   * Handle `'activate-request'` messages.
   */
  protected onActivateRequest(msg: Message): void {
    this.editor.focus();
  }

  /**
   * Handle `fit-request` messages.
   */
  protected onFitRequest(msg: Message): void {
    // need this for for when a theme changes font size
    this.editor.refresh();
  }

  /**
   * Handle `update-request` messages.
   */
  protected onUpdateRequest(msg: Message): void {
    if (!this._data) {
      return;
    }
    // Handle read only state.
    if (this.editor.getOption('readOnly') !== this._readOnly) {
      this.editor.setOption('readOnly', this._readOnly);
      this.toggleClass(READONLY_CLASS, this._readOnly);
    }
  }

  /**
   * Handle changes in the metadata.
   */
  protected onMetadataChanged(
    sender: Datastore,
    args: MapField.Change<ReadonlyJSONObject>
  ): void {
    if (args.current['jupyter']) {
      if (this.syncCollapse) {
        this.loadCollapseState();
      }
    }
    if (args.current['editable']) {
      if (this.syncEditable) {
        this.loadEditableState();
      }
    }
  }

  private _metadataListener: IDisposable;
  private _readOnly = false;
  private _data: ICellData.DataLocation = null;
  private _inputHidden = false;
  private _input: InputArea = null;
  private _inputWrapper: Widget = null;
  private _inputPlaceholder: InputPlaceholder = null;
  private _syncCollapse = false;
  private _syncEditable = false;
}

/**
 * The namespace for the `Cell` class statics.
 */
export namespace Cell {
  /**
   * An options object for initializing a cell widget.
   */
  export interface IOptions {
    /**
     * The model used by the cell.
     */
    data?: ICellData.DataLocation;

    /**
     * The factory object for customizable cell children.
     */
    contentFactory?: IContentFactory;

    /**
     * The configuration options for the text editor widget.
     */
    editorConfig?: Partial<CodeEditor.IConfig>;

    /**
     * Whether to send an update request to the editor when it is shown.
     */
    updateEditorOnShow?: boolean;
  }

  /**
   * The factory object for customizable cell children.
   *
   * This is used to allow users of cells to customize child content.
   *
   * This inherits from `OutputArea.IContentFactory` to avoid needless nesting and
   * provide a single factory object for all notebook/cell/outputarea related
   * widgets.
   */
  export interface IContentFactory
    extends OutputArea.IContentFactory,
      InputArea.IContentFactory {
    /**
     * Create a new cell header for the parent widget.
     */
    createCellHeader(): ICellHeader;

    /**
     * Create a new cell header for the parent widget.
     */
    createCellFooter(): ICellFooter;
  }

  /**
   * The default implementation of an `IContentFactory`.
   *
   * This includes a CodeMirror editor factory to make it easy to use out of the box.
   */
  export class ContentFactory implements IContentFactory {
    /**
     * Create a content factory for a cell.
     */
    constructor(options: ContentFactory.IOptions = {}) {
      this._editorFactory =
        options.editorFactory || InputArea.defaultEditorFactory;
    }

    /**
     * The readonly editor factory that create code editors
     */
    get editorFactory(): CodeEditor.Factory {
      return this._editorFactory;
    }

    /**
     * Create a new cell header for the parent widget.
     */
    createCellHeader(): ICellHeader {
      return new CellHeader();
    }

    /**
     * Create a new cell header for the parent widget.
     */
    createCellFooter(): ICellFooter {
      return new CellFooter();
    }

    /**
     * Create an input prompt.
     */
    createInputPrompt(): IInputPrompt {
      return new InputPrompt();
    }

    /**
     * Create the output prompt for the widget.
     */
    createOutputPrompt(): IOutputPrompt {
      return new OutputPrompt();
    }

    /**
     * Create an stdin widget.
     */
    createStdin(options: Stdin.IOptions): IStdin {
      return new Stdin(options);
    }

    private _editorFactory: CodeEditor.Factory = null;
  }

  /**
   * A namespace for cell content factory.
   */
  export namespace ContentFactory {
    /**
     * Options for the content factory.
     */
    export interface IOptions {
      /**
       * The editor factory used by the content factory.
       *
       * If this is not passed, a default CodeMirror editor factory
       * will be used.
       */
      editorFactory?: CodeEditor.Factory;
    }
  }

  /**
   * The default content factory for cells.
   */
  export const defaultContentFactory = new ContentFactory();
}

/******************************************************************************
 * CodeCell
 ******************************************************************************/

/**
 * A widget for a code cell.
 */
export class CodeCell extends Cell {
  /**
   * Construct a code cell widget.
   */
  constructor(options: CodeCell.IOptions) {
    super(options);
    this.addClass(CODE_CELL_CLASS);

    // Only save options not handled by parent constructor.
    let rendermime = (this._rendermime = options.rendermime);
    let contentFactory = this.contentFactory;
    let data = this.data;

    // Insert the output before the cell footer.
    let outputWrapper = (this._outputWrapper = new Panel());
    outputWrapper.addClass(CELL_OUTPUT_WRAPPER_CLASS);
    let outputCollapser = new OutputCollapser();
    outputCollapser.addClass(CELL_OUTPUT_COLLAPSER_CLASS);
    let output = (this._output = new OutputArea({
      data,
      rendermime,
      contentFactory: contentFactory
    }));
    output.addClass(CELL_OUTPUT_AREA_CLASS);
    // Set a CSS if there are no outputs, and connect a signal for future
    // changes to the number of outputs. This is for conditional styling
    // if there are no outputs.
    if (output.widgets.length === 0) {
      this.addClass(NO_OUTPUTS_CLASS);
    }
    output.outputLengthChanged.connect(this._outputLengthHandler, this);
    outputWrapper.addWidget(outputCollapser);
    outputWrapper.addWidget(output);
    (this.layout as PanelLayout).insertWidget(2, outputWrapper);

    this._outputPlaceholder = new OutputPlaceholder(() => {
      this.outputHidden = !this.outputHidden;
    });
    this._executionCountListener = DatastoreExt.listenField(
      { ...this.data.record, field: 'executionCount' },
      this.onExecutionCountChanged,
      this
    );
  }

  /**
   * The type of the cell widget.
   */
  type: nbformat.CellType = 'code';

  /**
   * Initialize view state from model.
   *
   * #### Notes
   * Should be called after construction. For convenience, returns this, so it
   * can be chained in the construction, like `new Foo().initializeState();`
   */
  initializeState(): this {
    super.initializeState();
    this.loadScrolledState();
    const executionCount = DatastoreExt.getField({
      ...this.data.record,
      field: 'executionCount'
    });

    this.setPrompt(`${executionCount || ''}`);
    return this;
  }

  /**
   * Get the output area for the cell.
   */
  get outputArea(): OutputArea {
    return this._output;
  }

  /**
   * The view state of output being collapsed.
   */
  get outputHidden(): boolean {
    return this._outputHidden;
  }
  set outputHidden(value: boolean) {
    if (this._outputHidden === value) {
      return;
    }
    let layout = this._outputWrapper.layout as PanelLayout;
    if (value) {
      layout.removeWidget(this._output);
      layout.addWidget(this._outputPlaceholder);
      if (this.inputHidden && !this._outputWrapper.isHidden) {
        this._outputWrapper.hide();
      }
    } else {
      if (this._outputWrapper.isHidden) {
        this._outputWrapper.show();
      }
      layout.removeWidget(this._outputPlaceholder);
      layout.addWidget(this._output);
    }
    this._outputHidden = value;
    if (this.syncCollapse) {
      this.saveCollapseState();
    }
  }

  /**
   * Save view collapse state to model
   */
  saveCollapseState() {
    // Because collapse state for a code cell involves two different pieces of
    // metadata (the `collapsed` and `jupyter` metadata keys), we block reacting
    // to changes in metadata until we have fully committed our changes.
    // Otherwise setting one key can trigger a write to the other key to
    // maintain the synced consistency.
    /* this._savingMetadata = true;

    try {
      super.saveCollapseState();
      const metadataLoc = { ...this.data.record, field: 'metadata' };
      const metadata = DatastoreExt.getField(metadataLoc);

      const collapsed: boolean | undefined = metadata['collapsed'];

      if (
        (this.outputHidden && collapsed === true) ||
        (!this.outputHidden && collapsed === undefined)
      ) {
        return;
      }

      // Do not set jupyter.outputs_hidden since it is redundant. See
      // and https://github.com/jupyter/nbformat/issues/137
      DatastoreExt.withTransaction(this.data.record.datastore, () => {
        if (this.outputHidden) {
          DatastoreExt.updateField(metadataLoc, { collapsed: true });
        } else {
          DatastoreExt.updateField(metadataLoc, { collapsed: null });
        }
      });
    } finally {
      this._savingMetadata = false;
    } */
  }

  /**
   * Revert view collapse state from model.
   *
   * We consider the `collapsed` metadata key as the source of truth for outputs
   * being hidden.
   */
  loadCollapseState() {
    // super.loadCollapseState();
    // this.outputHidden = !!this.model.metadata['collapsed'];
  }

  /**
   * Whether the output is in a scrolled state?
   */
  get outputsScrolled(): boolean {
    return this._outputsScrolled;
  }
  set outputsScrolled(value: boolean) {
    this.toggleClass('jp-mod-outputsScrolled', value);
    this._outputsScrolled = value;
    if (this.syncScrolled) {
      this.saveScrolledState();
    }
  }

  /**
   * Save view collapse state to model
   */
  saveScrolledState() {
    /* const { metadata } = this.model;
    const current = metadata['scrolled'];

    if (
      (this.outputsScrolled && current === true) ||
      (!this.outputsScrolled && current === undefined)
    ) {
      return;
    }
    DatastoreExt.withTransaction(this.model.record.datastore, () => {
      if (this.outputsScrolled) {
        DatastoreExt.updateField(
          { ...this.model.record, field: 'metadata' },
          { scrolled: true }
        );
      } else {
        DatastoreExt.updateField(
          { ...this.model.record, field: 'metadata' },
          { scrolled: null }
        );
      }
    }); */
  }

  /**
   * Revert view collapse state from model.
   */
  loadScrolledState() {
    /* const metadata = this.model.metadata;

    // We don't have the notion of 'auto' scrolled, so we make it false.
    if (metadata['scrolled'] === 'auto') {
      this.outputsScrolled = false;
    } else {
      this.outputsScrolled = !!metadata['scrolled'];
    } */
  }

  /**
   * Whether to sync the scrolled state to the cell model.
   */
  get syncScrolled(): boolean {
    return this._syncScrolled;
  }
  set syncScrolled(value: boolean) {
    if (this._syncScrolled === value) {
      return;
    }
    this._syncScrolled = value;
    if (value) {
      this.loadScrolledState();
    }
  }

  /**
   * Handle the input being hidden.
   *
   * #### Notes
   * This method is called by the case cell implementation and is
   * subclasses here so the code cell can watch to see when input
   * is hidden without accessing private state.
   */
  protected handleInputHidden(value: boolean): void {
    if (!value && this._outputWrapper.isHidden) {
      this._outputWrapper.show();
    } else if (value && !this._outputWrapper.isHidden && this._outputHidden) {
      this._outputWrapper.hide();
    }
  }

  /**
   * Clone the cell, using the same model.
   */
  clone(): CodeCell {
    let constructor = this.constructor as typeof CodeCell;
    return new constructor({
      data: this.data,
      contentFactory: this.contentFactory,
      rendermime: this._rendermime
    });
  }

  /**
   * Clone the OutputArea alone, returning a simplified output area, using the same model.
   */
  cloneOutputArea(): OutputArea {
    return new SimplifiedOutputArea({
      data: this.data,
      contentFactory: this.contentFactory,
      rendermime: this._rendermime
    });
  }

  /**
   * Dispose of the resources used by the widget.
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this._output.outputLengthChanged.disconnect(
      this._outputLengthHandler,
      this
    );
    this._executionCountListener.dispose();
    this._rendermime = null;
    this._output = null;
    this._outputWrapper = null;
    this._outputPlaceholder = null;
    super.dispose();
  }

  /**
   * Handle changes in the model.
   */
  protected onExecutionCountChanged(
    sender: Datastore,
    args: RegisterField.Change<nbformat.ExecutionCount>
  ): void {
    if (args.current !== null) {
      this.setPrompt(`${args.current}`);
    }
  }

  /**
   * Handle changes in the metadata.
   */
  protected onMetadataChanged(
    sender: Datastore,
    args: MapField.Change<ReadonlyJSONObject>
  ): void {
    if (this._savingMetadata) {
      // We are in middle of a metadata transaction, so don't react to it.
      return;
    }
    if (args.current['scrolled']) {
      if (this.syncScrolled) {
        this.loadScrolledState();
      }
    }
    if (args.current['collapsed']) {
      if (this.syncCollapse) {
        this.loadCollapseState();
      }
    }
    super.onMetadataChanged(sender, args);
  }

  /**
   * Handle changes in the number of outputs in the output area.
   */
  private _outputLengthHandler(sender: OutputArea, args: number) {
    let force = args === 0 ? true : false;
    this.toggleClass(NO_OUTPUTS_CLASS, force);
  }

  private _executionCountListener: IDisposable;
  private _rendermime: IRenderMimeRegistry = null;
  private _outputHidden = false;
  private _outputsScrolled: boolean;
  private _outputWrapper: Widget = null;
  private _outputPlaceholder: OutputPlaceholder = null;
  private _output: OutputArea = null;
  private _syncScrolled = false;
  private _savingMetadata = false;
}

/**
 * The namespace for the `CodeCell` class statics.
 */
export namespace CodeCell {
  /**
   * An options object for initializing a base cell widget.
   */
  export interface IOptions extends Cell.IOptions {
    /**
     * The mime renderer for the cell widget.
     */
    rendermime: IRenderMimeRegistry;
  }

  /**
   * Execute a cell given a client session.
   */
  export async function execute(
    cell: CodeCell,
    session: IClientSession,
    metadata?: JSONObject
  ): Promise<KernelMessage.IExecuteReplyMsg | void> {
    let code = cell.editor.model.value;
    if (!code.trim() || !session.kernel) {
      DatastoreExt.withTransaction(cell.data.record.datastore, () => {
        DatastoreExt.updateField(
          { ...cell.data.record, field: 'executionCount' },
          null
        );
        OutputAreaData.clear(cell.data);
      });
      return;
    }

    let cellId = { cellId: cell.data.record.record };
    metadata = { ...metadata, ...cellId };
    cell.outputHidden = false;
    cell.setPrompt('*');
    DatastoreExt.withTransaction(cell.data.record.datastore, () => {
      DatastoreExt.updateRecord(cell.data.record, {
        executionCount: null,
        trusted: true
      });
    });

    let future: Kernel.IFuture<
      KernelMessage.IExecuteRequestMsg,
      KernelMessage.IExecuteReplyMsg
    >;
    try {
      const msgPromise = OutputArea.execute(
        code,
        cell.outputArea,
        session,
        metadata
      );
      // Save this execution's future so we can compare in the catch below.
      future = cell.outputArea.future;
      const msg = await msgPromise;
      DatastoreExt.withTransaction(cell.data.record.datastore, () => {
        DatastoreExt.updateField(
          { ...cell.data.record, field: 'executionCount' },
          msg.content.execution_count
        );
      });
      return msg;
    } catch (e) {
      // If this is still the current execution, clear the prompt.
      if (e.message === 'Canceled' && cell.outputArea.future === future) {
        cell.setPrompt('');
      }
      throw e;
    }
  }
}

/******************************************************************************
 * MarkdownCell
 ******************************************************************************/

/**
 * A widget for a Markdown cell.
 *
 * #### Notes
 * Things get complicated if we want the rendered text to update
 * any time the text changes, the text editor model changes,
 * or the input area model changes.  We don't support automatically
 * updating the rendered text in all of these cases.
 */
export class MarkdownCell extends Cell {
  /**
   * Construct a Markdown cell widget.
   */
  constructor(options: MarkdownCell.IOptions) {
    super(options);
    this.addClass(MARKDOWN_CELL_CLASS);
    // Ensure we can resolve attachments:
    this._rendermime = options.rendermime.clone({
      resolver: new AttachmentsResolver({
        parent: options.rendermime.resolver,
        record: this.data.record
      })
    });

    // Throttle the rendering rate of the widget.
    this._debouncer = new Debouncer(() => {
      if (this._rendered) {
        this.update();
      }
    }, RENDER_TIMEOUT);

    this._listener = DatastoreExt.listenField(
      { ...this.editor.model.record, field: 'text' },
      () => this._debouncer.invoke()
    );

    void this._updateRenderedInput().then(() => {
      this._ready.resolve(void 0);
    });
    this.renderInput(this._renderer);
  }

  /**
   * The type of the cell widget.
   */
  readonly type: nbformat.CellType = 'markdown';

  /**
   * A promise that resolves when the widget renders for the first time.
   */
  get ready(): Promise<void> {
    return this._ready.promise;
  }

  /**
   * Whether the cell is rendered.
   */
  get rendered(): boolean {
    return this._rendered;
  }
  set rendered(value: boolean) {
    if (value === this._rendered) {
      return;
    }
    this._rendered = value;
    this._handleRendered();
    // Refreshing an editor can be really expensive, so we don't call it from
    // _handleRendered, since _handledRendered is also called on every update
    // request.
    if (!this._rendered) {
      this.editor.refresh();
    }
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this._listener.dispose();
    this._debouncer.dispose();
    super.dispose();
  }

  /**
   * Render an input instead of the text editor.
   */
  protected renderInput(widget: Widget): void {
    this.addClass(RENDERED_CLASS);
    this.inputArea.renderInput(widget);
  }

  /**
   * Show the text editor instead of rendered input.
   */
  protected showEditor(): void {
    this.removeClass(RENDERED_CLASS);
    this.inputArea.showEditor();
  }

  /*
   * Handle `update-request` messages.
   */
  protected onUpdateRequest(msg: Message): void {
    // Make sure we are properly rendered.
    this._handleRendered();
    super.onUpdateRequest(msg);
  }

  /**
   * Handle the rendered state.
   */
  private _handleRendered(): void {
    if (!this._rendered) {
      this.showEditor();
    } else {
      // TODO: It would be nice for the cell to provide a way for
      // its consumers to hook into when the rendering is done.
      void this._updateRenderedInput();
      this.renderInput(this._renderer);
    }
  }

  /**
   * Update the rendered input.
   */
  private _updateRenderedInput(): Promise<void> {
    let text = this.editor.model.value || DEFAULT_MARKDOWN_TEXT;
    // Do not re-render if the text has not changed.
    if (text !== this._prevText) {
      let mimeModel = new MimeModel({ data: { 'text/markdown': text } });
      if (!this._renderer) {
        this._renderer = this._rendermime.createRenderer('text/markdown');
        this._renderer.addClass(MARKDOWN_OUTPUT_CLASS);
      }
      this._prevText = text;
      return this._renderer.renderModel(mimeModel);
    }
    return Promise.resolve(void 0);
  }

  /**
   * Clone the cell, using the same model.
   */
  clone(): MarkdownCell {
    let constructor = this.constructor as typeof MarkdownCell;
    return new constructor({
      data: this.data,
      contentFactory: this.contentFactory,
      rendermime: this._rendermime
    });
  }

  private _listener: IDisposable;
  private _debouncer: Debouncer;
  private _renderer: IRenderMime.IRenderer = null;
  private _rendermime: IRenderMimeRegistry;
  private _rendered = true;
  private _prevText = '';
  private _ready = new PromiseDelegate<void>();
}

/**
 * The namespace for the `CodeCell` class statics.
 */
export namespace MarkdownCell {
  /**
   * An options object for initializing a base cell widget.
   */
  export interface IOptions extends Cell.IOptions {
    /**
     * The mime renderer for the cell widget.
     */
    rendermime: IRenderMimeRegistry;
  }
}

/******************************************************************************
 * RawCell
 ******************************************************************************/

/**
 * A widget for a raw cell.
 */
export class RawCell extends Cell {
  /**
   * Construct a raw cell widget.
   */
  constructor(options: Cell.IOptions) {
    super(options);
    this.addClass(RAW_CELL_CLASS);
  }

  /**
   * Clone the cell, using the same model.
   */
  clone(): RawCell {
    let constructor = this.constructor as typeof RawCell;
    return new constructor({
      data: this.data,
      contentFactory: this.contentFactory
    });
  }

  /**
   * The type of the cell widget.
   */
  readonly type: nbformat.CellType = 'raw';
}

/**
 * The namespace for the `RawCell` class statics.
 */
export namespace RawCell {
  /**
   * An options object for initializing a base cell widget.
   */
  export interface IOptions extends Cell.IOptions {}
}
