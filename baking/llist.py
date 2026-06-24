
class Node:
    def __init__(self):
        self.value = None
        self.next = None

class LinkedList:
    def __init__(self):
        self.head = None
        self.tail = None
        self.length = 0
    
    def append(self, value):
        self.length += 1
        new_node = Node()
        new_node.value = value

        if self.head is None:
            self.head = new_node
            self.tail = new_node
        else:
            self.tail.next = new_node
            self.tail = new_node
    
    def pop(self):
        if self.head is None:
            return None
        
        self.length -= 1
        value = self.head.value
        self.head = self.head.next

        if self.head is None:
            self.tail = None
        
        return value
    
    def peek(self):
        if self.head is None:
            return None
        
        return self.head.value

    def shift(self):
        if self.head is None:
            return None
        
        self.length -= 1
        value = self.tail.value

        if self.head == self.tail:
            self.head = None
            self.tail = None
            return value
        
        self.head = self.head.next
        return value

    def __len__(self):
        return self.length