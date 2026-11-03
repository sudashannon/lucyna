package sources

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	maxSourceBytes            = 32 << 20
	maxArchiveFiles           = 4096
	maxArchiveBytes     int64 = 128 << 20
	maxOfficeEntryBytes int64 = 32 << 20
	maxPDFTextBytes           = 16 << 20
)

var ErrUnsupported = errors.New("unsupported source format")

type Position struct {
	Kind  string `json:"kind"`
	Name  string `json:"name,omitempty"`
	Index int    `json:"index,omitempty"`
	Start int    `json:"start,omitempty"`
	End   int    `json:"end,omitempty"`
}

type Cell struct {
	Sheet string `json:"sheet"`
	Ref   string `json:"ref"`
	Type  string `json:"type,omitempty"`
	Value string `json:"value"`
}
type Document struct {
	Text      string     `json:"text"`
	Positions []Position `json:"positions,omitempty"`
	Cells     []Cell     `json:"cells,omitempty"`
	Format    string     `json:"format"`
}

// Parse extracts supported documents into bounded text with positions referring to the source structure.
func Parse(ctx context.Context, filename string, data []byte) (Document, error) {
	if err := ctx.Err(); err != nil {
		return Document{}, err
	}
	if len(data) > maxSourceBytes {
		return Document{}, fmt.Errorf("source exceeds %d bytes", maxSourceBytes)
	}
	ext := strings.ToLower(filepath.Ext(filename))
	switch ext {
	case ".md", ".markdown", ".txt":
		if !utf8.Valid(data) {
			return Document{}, errors.New("source text is not valid UTF-8")
		}
		text := strings.TrimSpace(string(data))
		return Document{Text: text, Format: strings.TrimPrefix(ext, "."), Positions: []Position{{Kind: "document", Start: 1, End: lineCount(text)}}}, nil
	case ".pdf":
		return parsePDF(ctx, data)
	case ".docx", ".pptx", ".xlsx":
		return parseOffice(ctx, ext, data)
	case ".doc", ".xls":
		return Document{}, fmt.Errorf("%w: %s (legacy binary formats are not supported)", ErrUnsupported, ext)
	default:
		return Document{}, fmt.Errorf("%w: %s", ErrUnsupported, ext)
	}
}

func parsePDF(ctx context.Context, data []byte) (Document, error) {
	if len(data) == 0 || !bytes.HasPrefix(data, []byte("%PDF-")) {
		return Document{}, errors.New("invalid PDF")
	}
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	in, err := os.CreateTemp("", "stele-source-*.pdf")
	if err != nil {
		return Document{}, err
	}
	input := in.Name()
	defer os.Remove(input)
	if _, err = in.Write(data); err != nil {
		in.Close()
		return Document{}, err
	}
	if err = in.Close(); err != nil {
		return Document{}, err
	}
	out, err := os.CreateTemp("", "stele-source-*.txt")
	if err != nil {
		return Document{}, err
	}
	output := out.Name()
	out.Close()
	defer os.Remove(output)
	cmd := exec.CommandContext(ctx, "lit", "parse", input, "--format", "text", "--no-ocr", "-o", output)
	var stderr boundedBuffer
	stderr.limit = 64 << 10
	cmd.Stderr = &stderr
	if err = cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return Document{}, fmt.Errorf("PDF extraction: %w", ctx.Err())
		}
		return Document{}, fmt.Errorf("PDF extraction failed: %w: %s", err, strings.TrimSpace(stderr.String()))
	}
	f, err := os.Open(output)
	if err != nil {
		return Document{}, fmt.Errorf("PDF extraction output: %w", err)
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, maxPDFTextBytes+1))
	if err != nil {
		return Document{}, err
	}
	if len(b) > maxPDFTextBytes {
		return Document{}, errors.New("PDF extracted text exceeds limit")
	}
	if !utf8.Valid(b) {
		return Document{}, errors.New("PDF extraction returned invalid UTF-8")
	}
	text := strings.TrimSpace(string(b))
	return Document{Text: text, Format: "pdf", Positions: []Position{{Kind: "document", Start: 1, End: lineCount(text)}}}, nil
}

type boundedBuffer struct {
	bytes.Buffer
	limit int
}

func (b *boundedBuffer) Write(p []byte) (int, error) {
	n := len(p)
	if remain := b.limit - b.Len(); remain > 0 {
		if remain < n {
			p = p[:remain]
		}
		_, _ = b.Buffer.Write(p)
	}
	return n, nil
}

func parseOffice(ctx context.Context, ext string, data []byte) (Document, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return Document{}, fmt.Errorf("invalid %s archive: %w", ext, err)
	}
	if err = ctx.Err(); err != nil {
		return Document{}, err
	}
	if len(zr.File) > maxArchiveFiles {
		return Document{}, errors.New("office archive contains too many entries")
	}
	var declared uint64
	files := make(map[string]*zip.File, len(zr.File))
	for _, f := range zr.File {
		if err = ctx.Err(); err != nil {
			return Document{}, err
		}
		clean := path.Clean(f.Name)
		if strings.HasPrefix(clean, "../") || clean == ".." || strings.HasPrefix(f.Name, "/") || strings.Contains(f.Name, "\\") {
			return Document{}, fmt.Errorf("unsafe archive path %q", f.Name)
		}
		if f.UncompressedSize64 > uint64(maxArchiveBytes) {
			return Document{}, errors.New("office archive entry exceeds size limit")
		}
		declared += f.UncompressedSize64
		if declared > uint64(maxArchiveBytes) {
			return Document{}, errors.New("office archive expands beyond size limit")
		}
		files[f.Name] = f
	}
	budget := &archiveBudget{}
	switch ext {
	case ".docx":
		return parseDocx(ctx, files, budget)
	case ".pptx":
		return parsePptx(ctx, files, budget)
	case ".xlsx":
		return parseXlsx(ctx, files, budget)
	}
	return Document{}, ErrUnsupported
}

type archiveBudget struct{ used int64 }
type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r contextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(p)
}
func readEntry(ctx context.Context, files map[string]*zip.File, name string, budget *archiveBudget) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	f := files[name]
	if f == nil {
		return nil, fmt.Errorf("missing office entry %s", name)
	}
	remaining := maxArchiveBytes - budget.used
	if remaining < 0 {
		return nil, errors.New("office archive expands beyond size limit")
	}
	limit := maxOfficeEntryBytes
	if remaining < limit {
		limit = remaining
	}
	r, e := f.Open()
	if e != nil {
		return nil, e
	}
	defer r.Close()
	b, e := io.ReadAll(io.LimitReader(contextReader{ctx: ctx, reader: r}, limit+1))
	if e != nil {
		return nil, e
	}
	if int64(len(b)) > limit {
		if remaining < maxOfficeEntryBytes {
			return nil, errors.New("office archive expands beyond size limit")
		}
		return nil, errors.New("office archive entry exceeds size limit")
	}
	budget.used += int64(len(b))
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return b, nil
}

const (
	maxXMLDepth = 128
	maxXMLNodes = 250000
)

type xmlNode struct {
	XMLName  xml.Name
	Text     string
	Children []xmlNode
	Attrs    []xml.Attr
}

func nodeText(ctx context.Context, n xmlNode) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	var b strings.Builder
	if strings.TrimSpace(n.Text) != "" {
		b.WriteString(n.Text)
	}
	for _, c := range n.Children {
		t, e := nodeText(ctx, c)
		if e != nil {
			return "", e
		}
		if t != "" && b.Len() > 0 {
			b.WriteByte(' ')
		}
		b.WriteString(t)
	}
	return strings.Join(strings.Fields(b.String()), " "), nil
}
func parseXML(ctx context.Context, files map[string]*zip.File, name string, budget *archiveBudget) (xmlNode, error) {
	b, e := readEntry(ctx, files, name, budget)
	if e != nil {
		return xmlNode{}, e
	}
	decoder := xml.NewDecoder(bytes.NewReader(b))
	decoder.Strict = true
	var start xml.StartElement
	for {
		if e = ctx.Err(); e != nil {
			return xmlNode{}, e
		}
		tok, tokenErr := decoder.Token()
		if tokenErr != nil {
			return xmlNode{}, fmt.Errorf("parse %s: %w", name, tokenErr)
		}
		if s, ok := tok.(xml.StartElement); ok {
			start = s
			break
		}
	}
	count := 0
	n, e := decodeXMLNode(ctx, decoder, start, 1, &count)
	if e != nil {
		return xmlNode{}, fmt.Errorf("parse %s: %w", name, e)
	}
	for {
		if e = ctx.Err(); e != nil {
			return xmlNode{}, e
		}
		tok, tokenErr := decoder.Token()
		if tokenErr == io.EOF {
			break
		}
		if tokenErr != nil {
			return xmlNode{}, fmt.Errorf("parse %s: %w", name, tokenErr)
		}
		if _, ok := tok.(xml.StartElement); ok {
			return xmlNode{}, fmt.Errorf("parse %s: multiple root elements", name)
		}
	}
	return n, nil
}
func decodeXMLNode(ctx context.Context, decoder *xml.Decoder, start xml.StartElement, depth int, count *int) (xmlNode, error) {
	if depth > maxXMLDepth {
		return xmlNode{}, errors.New("office XML nesting exceeds limit")
	}
	*count = *count + 1
	if *count > maxXMLNodes {
		return xmlNode{}, errors.New("office XML contains too many elements")
	}
	n := xmlNode{XMLName: start.Name, Attrs: append([]xml.Attr(nil), start.Attr...)}
	var text strings.Builder
	for {
		if err := ctx.Err(); err != nil {
			return xmlNode{}, err
		}
		tok, e := decoder.Token()
		if e != nil {
			return xmlNode{}, e
		}
		switch t := tok.(type) {
		case xml.StartElement:
			child, e := decodeXMLNode(ctx, decoder, t, depth+1, count)
			if e != nil {
				return xmlNode{}, e
			}
			n.Children = append(n.Children, child)
		case xml.EndElement:
			n.Text = text.String()
			return n, nil
		case xml.CharData:
			_, _ = text.Write(t)
		}
	}
}
func direct(n xmlNode, name string) []xmlNode {
	var out []xmlNode
	for _, c := range n.Children {
		if c.XMLName.Local == name {
			out = append(out, c)
		}
	}
	return out
}
func descendants(ctx context.Context, n xmlNode, name string) ([]xmlNode, error) {
	var out []xmlNode
	var walk func(xmlNode) error
	walk = func(x xmlNode) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if x.XMLName.Local == name {
			out = append(out, x)
		}
		for _, c := range x.Children {
			if err := walk(c); err != nil {
				return err
			}
		}
		return nil
	}
	if err := walk(n); err != nil {
		return nil, err
	}
	return out, nil
}
func attr(n xmlNode, key string) string {
	for _, a := range n.Attrs {
		if a.Name.Local == key {
			return a.Value
		}
	}
	return ""
}
func addBlock(b *strings.Builder, ps *[]Position, kind, name, text string, index int) {
	text = strings.TrimSpace(text)
	if text == "" {
		return
	}
	start := lineCount(b.String()) + 1
	if b.Len() > 0 {
		b.WriteByte('\n')
	}
	b.WriteString(text)
	*ps = append(*ps, Position{Kind: kind, Name: name, Index: index, Start: start, End: lineCount(b.String())})
}
func parseDocx(ctx context.Context, files map[string]*zip.File, budget *archiveBudget) (Document, error) {
	n, e := parseXML(ctx, files, "word/document.xml", budget)
	if e != nil {
		return Document{}, e
	}
	bodies, e := descendants(ctx, n, "body")
	if e != nil {
		return Document{}, e
	}
	var b strings.Builder
	var ps []Position
	index := 0
	for _, body := range bodies {
		for _, item := range body.Children {
			if e = ctx.Err(); e != nil {
				return Document{}, e
			}
			switch item.XMLName.Local {
			case "p":
				index++
				kind, name := "paragraph", ""
				styles, e := descendants(ctx, item, "pStyle")
				if e != nil {
					return Document{}, e
				}
				if len(styles) > 0 {
					style := attr(styles[0], "val")
					if strings.HasPrefix(strings.ToLower(style), "heading") || strings.EqualFold(style, "Title") {
						kind, name = "heading", style
					}
				}
				text, e := nodeText(ctx, item)
				if e != nil {
					return Document{}, e
				}
				addBlock(&b, &ps, kind, name, text, index)
			case "tbl":
				index++
				rows, e := descendants(ctx, item, "tr")
				if e != nil {
					return Document{}, e
				}
				var rowTexts []string
				for _, row := range rows {
					if e = ctx.Err(); e != nil {
						return Document{}, e
					}
					cells, e := descendants(ctx, row, "tc")
					if e != nil {
						return Document{}, e
					}
					var values []string
					for _, cell := range cells {
						text, e := nodeText(ctx, cell)
						if e != nil {
							return Document{}, e
						}
						values = append(values, text)
					}
					rowTexts = append(rowTexts, strings.Join(values, " | "))
				}
				addBlock(&b, &ps, "table", "", strings.Join(rowTexts, "\n"), index)
			}
		}
	}
	return Document{Text: b.String(), Positions: ps, Format: "docx"}, nil
}

func parsePptx(ctx context.Context, files map[string]*zip.File, budget *archiveBudget) (Document, error) {
	var names []string
	for n := range files {
		if err := ctx.Err(); err != nil {
			return Document{}, err
		}
		if strings.HasPrefix(n, "ppt/slides/slide") && strings.HasSuffix(n, ".xml") {
			names = append(names, n)
		}
	}
	sort.Slice(names, func(i, j int) bool { return slideNum(names[i]) < slideNum(names[j]) })
	var b strings.Builder
	var ps []Position
	for i, name := range names {
		if err := ctx.Err(); err != nil {
			return Document{}, err
		}
		n, e := parseXML(ctx, files, name, budget)
		if e != nil {
			return Document{}, e
		}
		shapes, e := descendants(ctx, n, "sp")
		if e != nil {
			return Document{}, e
		}
		var lines []string
		for _, shape := range shapes {
			text, e := nodeText(ctx, shape)
			if e != nil {
				return Document{}, e
			}
			if text != "" {
				lines = append(lines, text)
			}
		}
		addBlock(&b, &ps, "slide", filepath.Base(name), strings.Join(lines, "\n"), i+1)
	}
	return Document{Text: b.String(), Positions: ps, Format: "pptx"}, nil
}
func slideNum(s string) int {
	base := strings.TrimSuffix(filepath.Base(s), ".xml")
	var n int
	_, _ = fmt.Sscanf(strings.TrimPrefix(base, "slide"), "%d", &n)
	return n
}

type xlsxSheet struct {
	Name string
	Path string
}

func workbookSheets(ctx context.Context, files map[string]*zip.File, budget *archiveBudget) ([]xlsxSheet, error) {
	var names []xlsxSheet
	if files["xl/workbook.xml"] == nil {
		for name := range files {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			if strings.HasPrefix(name, "xl/worksheets/sheet") && strings.HasSuffix(name, ".xml") {
				names = append(names, xlsxSheet{Name: filepath.Base(name), Path: name})
			}
		}
		sort.Slice(names, func(i, j int) bool { return sheetNum(names[i].Path) < sheetNum(names[j].Path) })
		return names, nil
	}
	workbook, err := parseXML(ctx, files, "xl/workbook.xml", budget)
	if err != nil {
		return nil, err
	}
	rels, err := parseXML(ctx, files, "xl/_rels/workbook.xml.rels", budget)
	if err != nil {
		return nil, err
	}
	relationships, err := descendants(ctx, rels, "Relationship")
	if err != nil {
		return nil, err
	}
	targets := make(map[string]string)
	for _, rel := range relationships {
		if err = ctx.Err(); err != nil {
			return nil, err
		}
		targets[attr(rel, "Id")] = attr(rel, "Target")
	}
	sheets, err := descendants(ctx, workbook, "sheet")
	if err != nil {
		return nil, err
	}
	for _, sheet := range sheets {
		if err = ctx.Err(); err != nil {
			return nil, err
		}
		target := strings.TrimPrefix(targets[attr(sheet, "id")], "/")
		if !strings.HasPrefix(target, "xl/") {
			target = path.Join("xl", target)
		}
		target = path.Clean(target)
		if strings.HasPrefix(target, "../") || files[target] == nil {
			return nil, fmt.Errorf("invalid worksheet relationship %q", target)
		}
		name := attr(sheet, "name")
		if name == "" {
			name = filepath.Base(target)
		}
		names = append(names, xlsxSheet{Name: name, Path: target})
	}
	return names, nil
}

func parseXlsx(ctx context.Context, files map[string]*zip.File, budget *archiveBudget) (Document, error) {
	var shared []string
	if files["xl/sharedStrings.xml"] != nil {
		n, e := parseXML(ctx, files, "xl/sharedStrings.xml", budget)
		if e != nil {
			return Document{}, e
		}
		items, e := descendants(ctx, n, "si")
		if e != nil {
			return Document{}, e
		}
		for _, si := range items {
			text, e := nodeText(ctx, si)
			if e != nil {
				return Document{}, e
			}
			shared = append(shared, text)
		}
	}
	sheets, e := workbookSheets(ctx, files, budget)
	if e != nil {
		return Document{}, e
	}
	var b strings.Builder
	var ps []Position
	var cells []Cell
	index := 0
	for _, sheet := range sheets {
		if e = ctx.Err(); e != nil {
			return Document{}, e
		}
		n, e := parseXML(ctx, files, sheet.Path, budget)
		if e != nil {
			return Document{}, e
		}
		rows, e := descendants(ctx, n, "row")
		if e != nil {
			return Document{}, e
		}
		for _, row := range rows {
			if e = ctx.Err(); e != nil {
				return Document{}, e
			}
			var values []string
			for _, c := range direct(row, "c") {
				if e = ctx.Err(); e != nil {
					return Document{}, e
				}
				ref, typ := attr(c, "r"), attr(c, "t")
				if typ == "" {
					typ = "n"
				}
				var val, formula string
				for _, v := range c.Children {
					switch v.XMLName.Local {
					case "v":
						val = v.Text
					case "is":
						val, e = nodeText(ctx, v)
						if e != nil {
							return Document{}, e
						}
					case "f":
						formula = v.Text
					}
				}
				if typ == "s" {
					var idx int
					if _, scanErr := fmt.Sscan(val, &idx); scanErr == nil && idx >= 0 && idx < len(shared) {
						val = shared[idx]
					}
				}
				if formula != "" {
					val = "=" + formula + " → " + val
				}
				cells = append(cells, Cell{Sheet: sheet.Name, Ref: ref, Type: typ, Value: val})
				values = append(values, val)
			}
			index++
			addBlock(&b, &ps, "row", sheet.Name, strings.Join(values, " | "), index)
		}
	}
	return Document{Text: b.String(), Positions: ps, Cells: cells, Format: "xlsx"}, nil
}
func sheetNum(s string) int {
	base := strings.TrimSuffix(filepath.Base(s), ".xml")
	var n int
	_, _ = fmt.Sscanf(strings.TrimPrefix(base, "sheet"), "%d", &n)
	return n
}
func lineCount(s string) int {
	if s == "" {
		return 0
	}
	return strings.Count(s, "\n") + 1
}
