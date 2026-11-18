param([string]$Root, [string]$Title)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$form = [Windows.Forms.Form]::new()
$form.Text = $Title
$form.ClientSize = [Drawing.Size]::new(400, 215)
$editor = [Windows.Forms.TextBox]::new()
$editor.AccessibleName = 'Probe editor'
$editor.Multiline = $true
$editor.SetBounds(15, 15, 365, 95)
$form.Controls.Add($editor)
$editor.Add_TextChanged({ [IO.File]::WriteAllText("$Root/length", [string]$editor.Text.Length) })
$record = [Windows.Forms.Button]::new()
$record.Text = 'Record'
$record.SetBounds(15, 125, 100, 32)
$form.Controls.Add($record)
$record.Add_Click({ [IO.File]::AppendAllText("$Root/records", $editor.Text + '<END>') })
$open = [Windows.Forms.Button]::new()
$open.Text = 'Open file'
$open.SetBounds(125, 125, 110, 32)
$form.Controls.Add($open)
$open.Add_Click({ [void]$form.BeginInvoke([Action]{
    $dialog = [Windows.Forms.OpenFileDialog]::new()
    try {
        $dialog.Title = "$Title open"
        $dialog.InitialDirectory = $Root
        if ($dialog.ShowDialog($form) -eq 'OK') { [IO.File]::WriteAllText("$Root/opened", $dialog.FileName) }
    } finally { $dialog.Dispose() }
}) })
$form.Add_Paint({ param($sender, $event) $event.Graphics.FillRectangle([Drawing.Brushes]::RoyalBlue, 280, 125, 70, 50) })
$form.Add_MouseClick({
    param($sender, $event)
    if ([Drawing.Rectangle]::new(280, 125, 70, 50).Contains($event.Location)) { [IO.File]::AppendAllText("$Root/canvas", '1') }
})
$form.Add_Shown({
    $point = $form.PointToScreen([Drawing.Point]::new(315, 150))
    $target = @{ handle = [string]$form.Handle.ToInt64(); x = $point.X - $form.Left; y = $point.Y - $form.Top }
    [IO.File]::WriteAllText("$Root/window", ($target | ConvertTo-Json -Compress))
})
try { [Windows.Forms.Application]::Run($form) } finally { $form.Dispose() }
