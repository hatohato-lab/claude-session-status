# -*- coding: utf-8 -*-
"""claude-session-status を VS Code に入れるための包み（.vsix）を作る。

vsce（npm の道具）を入れずに済むよう、VSIX の中身（zip）を Python の標準ライブラリだけで組み立てる。
出力: dist/<name>-<version>.vsix
"""
import json
import os
import zipfile
from xml.sax.saxutils import escape

HERE = os.path.dirname(os.path.abspath(__file__))
FILES = ['package.json', 'extension.js', 'README.md', 'CHANGELOG.md']


def main():
    with open(os.path.join(HERE, 'package.json'), encoding='utf-8') as f:
        pkg = json.load(f)
    name, ver, pub = pkg['name'], pkg['version'], pkg['publisher']
    out = os.path.join(HERE, 'dist', '%s-%s.vsix' % (name, ver))
    os.makedirs(os.path.dirname(out), exist_ok=True)

    manifest = '''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="%s" Version="%s" Publisher="%s"/>
    <DisplayName>%s</DisplayName>
    <Description xml:space="preserve">%s</Description>
    <Categories>Other</Categories>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="%s"/>
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
  </Assets>
</PackageManifest>
''' % (name, ver, pub, escape(pkg['displayName']), escape(pkg['description']), escape(pkg['engines']['vscode']))

    content_types = '''<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json"/>
  <Default Extension=".js" ContentType="application/javascript"/>
  <Default Extension=".md" ContentType="text/markdown"/>
  <Default Extension=".vsixmanifest" ContentType="text/xml"/>
</Types>
'''

    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', content_types)
        z.writestr('extension.vsixmanifest', manifest)
        for fn in FILES:
            z.write(os.path.join(HERE, fn), 'extension/' + fn)   # zip の中の区切りは / にする
    print(out)


if __name__ == '__main__':
    main()
