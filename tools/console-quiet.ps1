# 关掉当前控制台的「快速编辑模式」。
#
# 为什么需要这个：
#
# Windows 控制台默认开启「快速编辑模式」，本意是让用户能用鼠标选中文字再复制。
# 但它的实现方式是——**只要用户在窗口里点一下鼠标，就进入选择状态，
# 此时任何想往这个控制台写输出的进程都会被系统挂起**。
#
# 对开发脚本来说这是灾难：编译跑到一半，用户在窗口里点了一下，
# 整个编译就停在那里，屏幕上什么都不再输出，看起来和卡死一模一样。
# 按回车或 Esc 才能解除。
#
# 这个脚本由启动脚本在开头调用，把当前控制台的快速编辑关掉。
# 关掉之后仍然可以用右键菜单里的「标记」来选中文字，所以复制能力没有丢。
#
# 注意：必须同时设置 ENABLE_EXTENDED_FLAGS，否则对
# ENABLE_QUICK_EDIT_MODE 的修改会被 Windows 忽略——这是文档里的要求，
# 不设的话改了等于没改。

Add-Type -Namespace Fuguang -Name ConsoleMode -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true)]
public static extern IntPtr GetStdHandle(int nStdHandle);

[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool GetConsoleMode(IntPtr hConsoleHandle, out uint lpMode);

[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool SetConsoleMode(IntPtr hConsoleHandle, uint dwMode);
'@ -ErrorAction SilentlyContinue

$STD_INPUT_HANDLE = -10
$ENABLE_QUICK_EDIT_MODE = 0x0040
$ENABLE_EXTENDED_FLAGS = 0x0080

$handle = [Fuguang.ConsoleMode]::GetStdHandle($STD_INPUT_HANDLE)
$mode = [uint32]0

if ([Fuguang.ConsoleMode]::GetConsoleMode($handle, [ref]$mode)) {
    $newMode = ($mode -bor $ENABLE_EXTENDED_FLAGS) -band (-bnot $ENABLE_QUICK_EDIT_MODE)
    if ($newMode -ne $mode) {
        [void][Fuguang.ConsoleMode]::SetConsoleMode($handle, $newMode)
    }
}

# 这个脚本是被启动脚本静默调用的，不产生任何输出。
# 失败也无所谓：最坏情况就是回到"点了窗口会暂停"的老行为，
# 用户按一下回车即可，不该因为它让启动流程出错。
exit 0
